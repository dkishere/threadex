import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { advanceMarkdownChunks, type MarkdownChunks } from "./markdownChunks";

function html(source: string) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: source }));
}

for (const [name, source] of Object.entries({
  paragraphs: "# Result\n\nFirst **paragraph**.\n\nSecond [link](https://example.com).\n\nLast",
  fence: "Before\n\n```ts\nconst x = 1;\n\n// blank inside fence\n```\n\nAfter",
  list: "Before\n\n- one\n\n- two\n  - nested\n\nAfter",
  table: "Before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter",
  setext: "Before\n\nHeading\n-------\n\nAfter",
  quote: "Before\n\n> quote\n>\n> continued\n\nAfter",
  indented: "Before\n\n    code\n    more\n\nAfter",
  reference: "A [link][later].\n\nAnother paragraph.\n\n[later]: https://example.com\n\nAfter",
  nestedReference: "A [link][later].\n\n> [later]: https://example.com\n\nAfter",
  html: "Before\n\n<div>\nraw HTML\n</div>\n\nAfter",
  crlf: "First\r\n\r\nSecond\r\n\r\nThird"
})) {
  test(`incremental Markdown preserves ${name} at every streamed character`, () => {
    let state: MarkdownChunks | null = null;
    for (let index = 1; index <= source.length; index++) {
      const current = source.slice(0, index);
      state = advanceMarkdownChunks(state, current);
      assert.equal([...state.frozen, state.tail].join(""), current);
      // ReactMarkdown may emit separator whitespace between root nodes, which
      // is immaterial outside pre/code blocks. Compare the rendered structure.
      const normalize = (value: string) => value.replace(/>\s+</g, "><");
      assert.equal(normalize([...state.frozen, state.tail].map(html).join("\n")), normalize(html(current)), `prefix ${index}`);
    }
  });
}

test("completed blocks stay stable and replacements discard the old prefix", () => {
  const first = advanceMarkdownChunks(null, "First\n\nSecond");
  const next = advanceMarkdownChunks(first, "First\n\nSecond grows");
  assert.equal(next.frozen, first.frozen);
  assert.equal(next.tail, "Second grows");
  const replaced = advanceMarkdownChunks(next, "Changed\n\nSecond");
  assert.equal([...replaced.frozen, replaced.tail].join(""), "Changed\n\nSecond");
});
