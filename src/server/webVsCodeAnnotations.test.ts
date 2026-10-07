import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { createWebVsCodeAnnotationsRouter, readWebVsCodeAnnotations } from "./webVsCodeAnnotations";

test("inbox retains messages until the owning session acknowledges them", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "annotation-inbox-"));
  const directory = resolve(root, "code-server/annotations");
  mkdirSync(directory, { recursive: true });
  const id = "12345678-1234-4234-8234-123456789012";
  writeFileSync(resolve(directory, `${id}.json`), JSON.stringify({
    version: 1, id, sessionId: "one", createdAt: new Date().toISOString(),
    annotation: { text: "code", annotation: "change", source: { type: "file", path: "a.ts", selection: { startLine: 1, endLine: 1, startColumn: 1, endColumn: 4 } } }
  }));
  writeFileSync(resolve(directory, "00000000-0000-0000-0000-000000000000.json"), "invalid");
  const app = express();
  app.use(createWebVsCodeAnnotationsRouter(root, {
    getActiveWorkspace: async () => ({ id: "workspace" }),
    getSession: async id => ({ workspaceId: id === "foreign" ? "other" : "workspace" })
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/foreign/vscode-annotations`)).status, 404);
    assert.equal(readWebVsCodeAnnotations(root, "two").length, 0);
    assert.equal((await (await fetch(`${base}/one/vscode-annotations`)).json()).annotations.length, 1);
    assert.equal(readWebVsCodeAnnotations(root, "one").length, 1);
    await fetch(`${base}/two/vscode-annotations/${id}`, { method: "DELETE" });
    assert.equal(readWebVsCodeAnnotations(root, "one").length, 1);
    await fetch(`${base}/one/vscode-annotations/${id}`, { method: "DELETE" });
    assert.equal(readWebVsCodeAnnotations(root, "one").length, 0);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
