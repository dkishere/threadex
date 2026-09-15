import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonFileViewer, MarkdownContent } from "./MarkdownContent";

test("renders an absolute workspace image link as an inline preview", () => {
  const path = "/Volumes/dev/tools/session-manager/concept image.png";
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, { children: `[concept](${path.replaceAll(" ", "%20")})` })
  );

  const fileUrl = `/api/workspaces/file?path=${encodeURIComponent(path)}`;
  assert.match(html, /class="markdown-image-preview"/);
  assert.ok(html.includes(`href="${fileUrl}"`));
  assert.ok(html.includes(`src="${fileUrl}"`));
  assert.match(html, /<span>concept<\/span>/);
});

test("renders non-image workspace links as popup triggers", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, { children: "[notes](/Volumes/dev/tools/session-manager/notes.md:12)" })
  );

  assert.doesNotMatch(html, /markdown-image-preview/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-workspace-file-link="true"/);
  assert.match(html, /path=%2FVolumes%2Fdev%2Ftools%2Fsession-manager%2Fnotes.md&amp;line=12/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("renders Codex session links as same-tab Threadex routes", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      children: "[child task](codex://threads/local_123?workspace=threadex)"
    })
  );

  assert.match(html, /href="\?sessionId=local_123&amp;workspaceId=threadex"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("renders JSON with only the root expanded initially", () => {
  const html = renderToStaticMarkup(
    React.createElement(JsonFileViewer, { content: '{"name":"Ada","details":{"role":"admin"}}' })
  );

  assert.match(html, /data-json-depth="0"[^>]*aria-expanded="true"/);
  assert.match(html, /data-json-depth="1"[^>]*aria-expanded="false"/);
  assert.match(html, /&quot;name&quot;: /);
  assert.match(html, /&quot;details&quot;: /);
});
