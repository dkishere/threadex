import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, win32 } from "node:path";
import test from "node:test";
import { runnerFileName } from "./runnerFileName.js";

test("ordinary runner IDs retain their existing filenames", () => {
  for (const id of ["turn-123", "local_abc", "turn-123.attempt-456"]) {
    assert.equal(runnerFileName(id), id);
  }
});

test("monitor wake IDs and unsafe IDs produce portable, distinct filenames", () => {
  const ids = [
    "wait_process_wake:wait_event_9bdae1f5-94c5-423c-8a37-06b884336cbb:local_mu5x5w20_5k374n413r1y1i4i",
    "a:b", "a?b", "a_b", "../escape", "..\\escape", "CON", "nul.txt",
    "LPT1", "trailing.", "", "x".repeat(300), "你好"
  ];
  const names = ids.map(runnerFileName);
  assert.equal(new Set(names).size, ids.length);
  for (const [index, name] of names.entries()) {
    assert.equal(name, runnerFileName(ids[index]));
    assert.equal(win32.basename(name), name);
    assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/);
    assert.ok(name.length <= 120);
  }
  assert.notEqual(runnerFileName(names[0]), names[0]);
});

test("wake job and log files can be written and reopened with the original ID intact", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "runner-filename-"));
  const turnId = "wait_process_wake:wait_event_123:local_456";
  try {
    for (const suffix of [".json", ".ndjson", ".stdout.log", ".stderr.log"]) {
      const path = resolve(directory, `${runnerFileName(turnId)}${suffix}`);
      writeFileSync(path, JSON.stringify({ turnId }));
      assert.equal(JSON.parse(readFileSync(path, "utf8")).turnId, turnId);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
