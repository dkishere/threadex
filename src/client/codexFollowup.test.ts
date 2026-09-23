import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { remarkCodexFileCitation, remarkCodexFollowup } from "./codexFollowup";

test("follow-up prompt preserves escaped quotes, newlines and Windows paths", () => {
  const prompt = 'Review "camera"\nC:\\evidence\\74be';
  const source = `:codex-followup[Review]{prompt=${JSON.stringify(prompt)}}`;
  const tree = unified().use(remarkParse).parse(source);
  remarkCodexFollowup()(tree, { value: source });
  assert.equal(tree.children[0].data?.hProperties?.["data-followup-prompt"], prompt);
});

test("file citation identifies output files and rejects relative paths", () => {
  const source = ':codex-file-citation{path="/tmp/report.csv" purpose="output"}';
  const tree = unified().use(remarkParse).parse(source);
  remarkCodexFileCitation()(tree, { value: source });
  assert.equal(tree.children[0].data?.hName, "a");
  assert.equal(tree.children[0].data?.hProperties?.href, "/tmp/report.csv");

  const relative = ':codex-file-citation{path="report.csv"}';
  const relativeTree = unified().use(remarkParse).parse(relative);
  remarkCodexFileCitation()(relativeTree, { value: relative });
  assert.equal(relativeTree.children[0].data, undefined);
});

test("invalid escapes and incomplete streamed directives remain text", () => {
  const source = ':codex-followup[Review]{prompt="Audit"}';
  for (const value of [':codex-followup[Review]{prompt="bad\\q"}', ...Array.from({ length: source.length }, (_, i) => source.slice(0, i))]) {
    const tree = unified().use(remarkParse).parse(value);
    remarkCodexFollowup()(tree, { value });
    assert.ok(tree.children.every((node) => !node.data?.hProperties));
  }
});
