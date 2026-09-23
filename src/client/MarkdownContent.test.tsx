import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("slash-prefixed Windows report output renders as an in-app image preview", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownWorkspaceContext.Provider,
    { value: { sessionId: "local_report", workspaceId: "default" } },
    React.createElement(MarkdownContent, { children: "[畫面對照](/C:/AI/head/outputs/comparison_0.jpg)" })));
  assert.match(html, /class="markdown-image-preview"/);
  assert.match(html, /path=C%3A%2FAI%2Fhead%2Foutputs%2Fcomparison_0.jpg/);
  assert.match(html, /sessionId=local_report/);
  assert.doesNotMatch(html, /target="_blank"/);
});
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

test("renders Codex follow-up suggestions as buttons while preserving code and incomplete text", () => {
  const directive = ':codex-followup[Review priority-60 sessions]{prompt="Audit the recurrent camera evidence for 74be and c185."}';
  const render = (children: string) => renderToStaticMarkup(React.createElement(MarkdownContent, { children }));
  assert.match(render(directive), /<button[^>]*>Review priority-60 sessions<\/button>/);
  assert.doesNotMatch(render(`\`${directive}\``), /<button/);
  assert.doesNotMatch(render(`\`\`\`\n${directive}\n\`\`\``), /<button/);
  assert.doesNotMatch(render(directive.slice(0, -1)), /<button/);
  assert.doesNotMatch(render(':codex-followup[Empty]{prompt=" "}'), /<button/);
});

test("renders Codex output file citations as workspace file links", () => {
  const path = "/tmp/a7deca0c-610f-48c6-b6d9-e8bce39f0699-screenshots.csv";
  const directive = `:codex-file-citation{path="${path}" purpose="output"}`;
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { children: directive }));
  assert.match(html, /class="codex-file-citation"/);
  assert.match(html, /Output: a7deca0c-610f-48c6-b6d9-e8bce39f0699-screenshots\.csv/);
  assert.ok(html.includes(`/api/workspaces/file?path=${encodeURIComponent(path)}`));
});

test("leaves invalid, relative and code-block file citations as text", () => {
  const citation = ':codex-file-citation{path="/tmp/output.csv" purpose="output"}';
  const render = (children: string) => renderToStaticMarkup(React.createElement(MarkdownContent, { children }));
  for (const source of [':codex-file-citation{path="output.csv"}', ':codex-file-citation{path="/tmp/a.csv" path="/tmp/b.csv"}', `\`${citation}\``, `\`\`\`\n${citation}\n\`\`\``]) {
    assert.doesNotMatch(render(source), /class="codex-file-citation"/);
  }
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
