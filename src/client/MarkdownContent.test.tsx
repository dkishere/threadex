import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonFileViewer, MarkdownContent, MarkdownWorkspaceContext } from "./MarkdownContent";

test("file links use the displayed session context without URL query parameters", () => {
  const render = (sessionId: string) => renderToStaticMarkup(React.createElement(
    MarkdownWorkspaceContext.Provider,
    { value: { sessionId, workspaceId: "default" } },
    React.createElement(MarkdownContent, { children: "[report](C:/AI/head/report.html) [image](C:/AI/head/image.png)" })
  ));
  const html = render("local_project");
  assert.match(html, /html\/default\/local_project\/windows/);
  assert.match(html, /sessionId=local_project&amp;workspaceId=default/);
  assert.doesNotMatch(html, /html\/active\/none/);
  const switched = render("local_other");
  assert.match(switched, /html\/default\/local_other\/windows/);
  assert.doesNotMatch(switched, /local_project/);
});

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

test("HTML links offer a separate new-tab preview icon", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { children: "[report](C:/AI/head/report.html)" }));
  assert.match(html, /data-workspace-file-link="true"/);
  assert.match(html, /aria-label="Open HTML preview in new tab"/);
  assert.match(html, /href="\/api\/workspaces\/html\/active\/none\/windows\/C%3A\/AI\/head\/report.html"/);
  assert.match(html, /target="_blank"/);
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
