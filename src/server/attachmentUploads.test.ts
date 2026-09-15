import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { saveUploadedAttachments } from "./attachmentUploads";

test("resending a stored browser context copies it into the new turn", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-attachment-uploads-"));
  const uploadDir = resolve(root, "uploads");
  const sourcePath = resolve(uploadDir, "original-turn", "01-browser-bridge-context.json");
  mkdirSync(resolve(uploadDir, "original-turn"), { recursive: true });
  writeFileSync(sourcePath, JSON.stringify({ kind: "browser-bridge-context", tabId: 42 }));

  try {
    const saved = saveUploadedAttachments(uploadDir, "resent-turn", [{
      id: "context-1",
      name: "browser-bridge-context.json",
      type: "application/json",
      path: "original-turn/01-browser-bridge-context.json"
    }]);

    assert.deepEqual(saved.map(({ id, name, mimeType, size, path }) => ({
      id,
      name,
      mimeType,
      size,
      path: path.replace(uploadDir, "")
    })), [{
      id: "context-1",
      name: "browser-bridge-context.json",
      mimeType: "application/json",
      size: 44,
      path: "/resent-turn/01-browser-bridge-context.json"
    }]);
    assert.equal(readFileSync(saved[0]!.path, "utf8"), readFileSync(sourcePath, "utf8"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("stored attachment paths outside uploads remain invalid", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-attachment-uploads-"));
  const uploadDir = resolve(root, "uploads");
  mkdirSync(uploadDir, { recursive: true });

  try {
    assert.throws(
      () => saveUploadedAttachments(uploadDir, "resent-turn", [{
        name: "outside.json",
        type: "application/json",
        path: resolve(root, "outside.json")
      }]),
      /Invalid upload payload for outside\.json\./
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("path attachments can exceed the data URL limit and are moved into the turn", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-attachment-uploads-"));
  const uploadDir = resolve(root, "uploads");
  const sourceDir = resolve(uploadDir, "staged", "large-file");
  const sourcePath = resolve(sourceDir, "01-recording.mp4");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(sourcePath, "");
  truncateSync(sourcePath, 5 * 1024 * 1024);

  try {
    const saved = saveUploadedAttachments(uploadDir, "large-turn", [{
      id: "large-1",
      name: "recording.mp4",
      type: "video/mp4",
      path: "staged/large-file/01-recording.mp4"
    }]);

    assert.equal(saved[0]?.size, 5 * 1024 * 1024);
    assert.equal(existsSync(saved[0]?.path ?? ""), true);
    assert.equal(existsSync(sourceDir), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
