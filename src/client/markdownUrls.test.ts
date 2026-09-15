import assert from "node:assert/strict";
import test from "node:test";
import { isJsonFilePath, isMarkdownFilePath, localFilePathFromMarkdownUrl, threadexNavigationUrl, transformMarkdownUrl, workspaceFilePreviewUrl, workspaceFileReferenceFromUrl, workspaceImagePreviewName } from "./markdownUrls";

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

test("converts scoped Codex session references into Threadex routes", () => {
  assert.equal(
    threadexNavigationUrl("codex://threads/local_123?workspace=threadex"),
    "?sessionId=local_123&workspaceId=threadex"
  );
  assert.equal(threadexNavigationUrl("codex://threads/thread_123"), null);
});

test("identifies passive workspace images for inline previews", () => {
  const imageUrl = transformMarkdownUrl("/Volumes/dev/My Project/concept image.PNG");
  assert.equal(workspaceImagePreviewName(imageUrl), "concept image.PNG");
  assert.equal(workspaceImagePreviewName(transformMarkdownUrl("/Volumes/dev/My Project/model.svg")), null);
  assert.equal(workspaceImagePreviewName("https://example.com/concept.png"), null);
});
