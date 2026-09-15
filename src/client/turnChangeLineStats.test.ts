import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx, jsxs } from "react/jsx-runtime";
import { FileChangeList, fileChangeLineStats } from "./sessionHelpers02.js";

test("counts added and deleted lines from a unified diff without counting headers", () => {
  assert.deepEqual(fileChangeLineStats({}, {
    path: "src/example.ts",
    kind: "update",
    unifiedDiff: [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+extra",
      " unchanged"
    ].join("\n")
  }), { additions: 2, deletions: 1 });
});

test("uses explicit line totals and preserves zero values", () => {
  assert.deepEqual(fileChangeLineStats({}, {
    path: "src/empty.ts",
    kind: "update",
    additions: 0,
    deletions: 0,
    unifiedDiff: "+ignored"
  }), { additions: 0, deletions: 0 });
});

test("counts full contents for added and deleted files", () => {
  assert.deepEqual(fileChangeLineStats({}, {
    path: "src/added.ts",
    kind: "add",
    afterContent: "one\ntwo\n"
  }), { additions: 2, deletions: 0 });
  assert.deepEqual(fileChangeLineStats({}, {
    path: "src/deleted.ts",
    kind: "delete",
    beforeContent: "one\ntwo"
  }), { additions: 0, deletions: 2 });
});

test("renders plus and minus counts for every turn change, including zero", () => {
  const changes = [
    { path: "src/changed.ts", kind: "update", unifiedDiff: "@@ -1 +1,2 @@\n-old\n+new\n+extra" },
    { path: "src/unchanged.ts", kind: "update", additions: 0, deletions: 0 }
  ];
  const ctx = {
    FileEditIcon: () => jsx("svg", {}),
    FileChangeDiffPopup: () => null,
    _Fragment: Fragment,
    _jsx: jsx,
    _jsxs: jsxs,
    compactFilePath: (path: string) => path,
    fileChangeLabel: () => "Edited",
    fileChangeTone: () => "update",
    useState
  };
  function TestList() {
    return FileChangeList(ctx, { changes });
  }

  const html = renderToStaticMarkup(createElement(TestList));
  assert.equal((html.match(/class="file-change-lines"/g) ?? []).length, 2);
  assert.match(html, />\+2<\/span><span data-tone="delete">−1<\/span>/);
  assert.match(html, />\+0<\/span><span data-tone="delete">−0<\/span>/);
});
