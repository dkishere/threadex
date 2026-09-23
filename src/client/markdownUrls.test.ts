import assert from "node:assert/strict";
import test from "node:test";

test("normalizes slash-prefixed Windows output links and file URIs", () => {
  const path = "C:/AI/head/outputs/comparison_0.jpg";
  for (const input of ["/" + path, "file:///" + path, "/C%3A/AI/head/outputs/comparison_0.jpg"]) {
    assert.equal(localFilePathFromMarkdownUrl(input), path);
    assert.equal(transformMarkdownUrl(input, { sessionId: "local_report", workspaceId: "default" }),
      `/api/workspaces/file?path=${encodeURIComponent(path)}&sessionId=local_report&workspaceId=default`);
  }
});
import { isHtmlFilePath, workspaceHtmlPreviewUrl } from "./markdownUrls";

test("HTML routes retain context and directories for dynamic relative assets", () => {
  const route = workspaceHtmlPreviewUrl("C:\\AI\\head\\outputs\\my report.html", { workspaceId: "default", sessionId: "local_123" });
  assert.equal(route, "/api/workspaces/html/default/local_123/windows/C%3A/AI/head/outputs/my%20report.html");
  const asset = new URL("images/hair 1.png", `http://localhost${route}`);
  assert.equal(asset.pathname, "/api/workspaces/html/default/local_123/windows/C%3A/AI/head/outputs/images/hair%201.png");
  assert.equal(workspaceHtmlPreviewUrl("/tmp/report.html"), "/api/workspaces/html/active/none/posix/tmp/report.html");
  assert.equal(isHtmlFilePath("report.HTM"), true);
  assert.equal(isHtmlFilePath("report.html.txt"), false);
});
import { isJsonFilePath, isMarkdownFilePath, localFilePathFromMarkdownUrl, resolveWorkspaceMarkdownUrl, threadexNavigationUrl, transformMarkdownUrl, workspaceFileDownloadUrl, workspaceFilePreviewUrl, workspaceFileReferenceFromUrl, workspaceImagePreviewName } from "./markdownUrls";

test("rewrites absolute workspace paths through the workspace file endpoint", () => {
  const path = "/Volumes/dev/My Project/concept image.png";
  assert.equal(
    transformMarkdownUrl(path),
    `/api/workspaces/file?path=${encodeURIComponent(path)}`
  );
});

test("rewrites file URLs and decodes their path", () => {
  assert.equal(
    localFilePathFromMarkdownUrl("file:///Volumes/dev/My%20Project/image.png"),
    "/Volumes/dev/My Project/image.png"
  );
});

test("keeps a Markdown file-link line number separate from its workspace path", () => {
  const url = transformMarkdownUrl("/Volumes/dev/My Project/src/App.tsx:42");
  assert.equal(url, `/api/workspaces/file?path=${encodeURIComponent("/Volumes/dev/My Project/src/App.tsx")}&line=42`);
  assert.deepEqual(workspaceFileReferenceFromUrl(url), { path: "/Volumes/dev/My Project/src/App.tsx", line: 42 });
});

test("keeps the transcript session and workspace on rendered workspace file URLs", () => {
  const path = "C:/AI/head/outputs/comparison.jpg";
  assert.equal(
    transformMarkdownUrl(path, { sessionId: "local_123", workspaceId: "default" }),
    `/api/workspaces/file?path=${encodeURIComponent(path)}&sessionId=local_123&workspaceId=default`
  );
});

test("marks workspace file URLs for an explicit download", () => {
  const url = transformMarkdownUrl("C:/AI/head/outputs/comparison.jpg", { sessionId: "local_123" });
  assert.equal(workspaceFileDownloadUrl(url), `${url}&download=1`);
});

test("uses the transcript session and workspace when loading a workspace file preview", () => {
  assert.equal(
    workspaceFilePreviewUrl("/Volumes/dev/cheat-detection/report.md", { sessionId: "local_123", workspaceId: "default" }),
    "/api/workspaces/file-preview?path=%2FVolumes%2Fdev%2Fcheat-detection%2Freport.md&sessionId=local_123&workspaceId=default"
  );
});

test("identifies Markdown files for rendered previews", () => {
  assert.equal(isMarkdownFilePath("/Volumes/dev/report.md"), true);
  assert.equal(isMarkdownFilePath("/Volumes/dev/report.MARKDOWN"), true);
  assert.equal(isMarkdownFilePath("/Volumes/dev/report.mdx"), false);
});

test("identifies JSON files for tree previews", () => {
  assert.equal(isJsonFilePath("/Volumes/dev/report.json"), true);
  assert.equal(isJsonFilePath("/Volumes/dev/report.JSON"), true);
  assert.equal(isJsonFilePath("/Volumes/dev/report.jsonl"), false);
});

test("leaves web, codex, relative, and app URLs unchanged", () => {
  for (const url of [
    "https://example.com/image.png",
    "codex://threads/local_123?workspace=threadex",
    "images/example.png",
    "/api/health",
    "/assets/example.png",
    "//cdn.example.com/image.png"
  ]) {
    assert.equal(transformMarkdownUrl(url), url);
  }
});

test("resolves workspace Markdown links beside the previewed file", () => {
  const source = "/Volumes/dev/My Project/docs/report.md";
  assert.equal(resolveWorkspaceMarkdownUrl("../images/chart%201.png", source), "/Volumes/dev/My Project/images/chart 1.png");
  assert.equal(resolveWorkspaceMarkdownUrl("./notes.md", source), "/Volumes/dev/My Project/docs/notes.md");
  assert.equal(resolveWorkspaceMarkdownUrl("../images/chart.png", "C:\\AI\\docs\\report.md"), "C:/AI/images/chart.png");
  for (const url of ["#section", "?raw=1", "/api/health", "https://example.com/report", "codex://threads/local_123"]) {
    assert.equal(resolveWorkspaceMarkdownUrl(url, source), url);
  }
});

test("converts scoped Codex session references into Threadex routes", () => {
  assert.equal(
    threadexNavigationUrl("codex://threads/local_123?workspace=threadex"),
    "?sessionId=tx_123&workspaceId=threadex"
  );
  assert.equal(threadexNavigationUrl("codex://threads/thread_123"), "?threadId=thread_123");
  assert.equal(threadexNavigationUrl("threadex://default/tx_123/turn-2"), "?sessionId=tx_123&workspaceId=default&turnId=turn-2");
  assert.equal(threadexNavigationUrl("threadex://default/tx_123#3/1/2/1"), "?sessionId=tx_123&workspaceId=default&turnNumbers=1%2F2%2F3");
});

test("identifies passive workspace images for inline previews", () => {
  const imageUrl = transformMarkdownUrl("/Volumes/dev/My Project/concept image.PNG");
  assert.equal(workspaceImagePreviewName(imageUrl), "concept image.PNG");
  assert.equal(workspaceImagePreviewName(transformMarkdownUrl("/Volumes/dev/My Project/model.svg")), null);
  assert.equal(workspaceImagePreviewName("https://example.com/concept.png"), null);
});
