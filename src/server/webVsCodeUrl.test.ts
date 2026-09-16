import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { readWebVsCodeTunnelHost, resolveWebVsCodeUrl, setWebVsCodePaths } from "./webVsCodeUrl";

test("normalizes Windows folders and encodes remote file URI paths", () => {
  const url = new URL("https://code.example/");
  setWebVsCodePaths(url, "B:\\threadex", "B:\\threadex\\src\\file #1.tsx");
  assert.equal(url.searchParams.get("folder"), "/B:/threadex");
  const payload = JSON.parse(url.searchParams.get("payload")!);
  const file = new URL(payload[1][1]);
  assert.equal(file.host, "remote");
  assert.equal(decodeURIComponent(file.pathname), "/B:/threadex/src/file #1.tsx");
  assert.equal(file.hash, "");
});

test("preserves POSIX folder paths and supports folder-only links", () => {
  const url = new URL("https://code.example/");
  setWebVsCodePaths(url, "/work/project");
  assert.equal(url.searchParams.get("folder"), "/work/project");
  assert.equal(url.searchParams.has("payload"), false);
  setWebVsCodePaths(url, "/work/project", "/work/project/a.ts");
  assert.equal(JSON.parse(url.searchParams.get("payload")!)[1][1], "vscode-remote://remote/work/project/a.ts");
});

function request(headers: Record<string, string>, protocol = "http") {
  return {
    protocol,
    get(name: string) {
      return headers[name.toLowerCase()];
    }
  };
}

test("prefers the explicitly configured Web VS Code URL", () => {
  const url = resolveWebVsCodeUrl(request({ host: "threadex.example" }), {
    defaultPort: 8790,
    projectRoot: process.cwd(),
    env: { WEB_VSCODE_URL: "https://code.example/" }
  });

  assert.equal(url.toString(), "https://code.example/");
});

test("uses the public Web VS Code ingress for a tunnel request", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-url-"));
  try {
    const configDir = resolve(root, "cloudflared");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, "config.yml"), [
      "ingress:",
      "  - hostname: threadex.example",
      "    service: http://127.0.0.1:5173",
      "  - hostname: threadex-code.example",
      "    service: http://127.0.0.1:8790",
      "  - service: http_status:404",
      ""
    ].join("\n"), "utf8");

    const url = resolveWebVsCodeUrl(request({
      host: "threadex.example",
      "x-forwarded-proto": "https"
    }), { defaultPort: 8790, projectRoot: root });

    assert.equal(url.toString(), "https://threadex-code.example/");
    assert.equal(readWebVsCodeTunnelHost(resolve(configDir, "config.yml"), 8790), "threadex-code.example");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps local requests on the loopback Web VS Code port", () => {
  const url = resolveWebVsCodeUrl(request({ host: "localhost:8787" }), {
    defaultPort: 8790,
    projectRoot: process.cwd()
  });

  assert.equal(url.toString(), "http://127.0.0.1:8790/");
});

test("falls back to the forwarded public origin when no tunnel route is available", () => {
  const url = resolveWebVsCodeUrl(request({
    "x-forwarded-host": "threadex.example",
    "x-forwarded-proto": "https"
  }), {
    defaultPort: 8790,
    projectRoot: resolve(tmpdir(), "missing-threadex-tunnel-config")
  });

  assert.equal(url.toString(), "https://threadex.example/");
});
