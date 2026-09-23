import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseCodexReference } from "../codexReference";
import { finishGitProvenance, inspectGitProvenance, installGitProvenanceHooks, parseGitProvenance, prepareGitProvenance, recordGitProvenance, recordLiveGitProvenance } from "./gitProvenance";

test("groups numbered turns per workspace/session and consumes only committed associations", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-numbered-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    installGitProvenanceHooks(cwd, fileURLToPath(new URL("../../scripts/git-provenance.ts", import.meta.url)), import.meta.resolve("tsx"));
    writeFileSync(resolve(cwd, "a.txt"), "a\n");
    writeFileSync(resolve(cwd, "b.txt"), "b\n");
    for (const n of [3, 1, 2]) recordGitProvenance(cwd, "local_task", `uuid-${n}`, ["a.txt"], `event-${n}`, "ws", n);
    recordGitProvenance(cwd, "tx_task", "uuid-2", ["a.txt"], "duplicate", "ws", 2);
    recordGitProvenance(cwd, "tx_task", "uuid-4", ["b.txt"], "unstaged", "ws", 4);
    recordGitProvenance(cwd, "tx_task", "other-uuid", ["a.txt"], "other", "other-ws", 9);
    git("add", "a.txt");
    const message = resolve(cwd, ".git", "message");
    writeFileSync(message, "Grouped\n");
    prepareGitProvenance(cwd, message); prepareGitProvenance(cwd, message);
    git("commit", "-q", "-F", message);
    const body = git("show", "-s", "--format=%B", "HEAD");
    assert.equal(body.split("\n").filter(line => line.startsWith("Threadex-author:")).length, 2);
    assert.match(body, /Threadex-author: threadex:\/\/ws\/tx_task#1\/2\/3/);
    assert.match(body, /Threadex-author: threadex:\/\/other-ws\/tx_task#9/);
    assert.doesNotMatch(body, /uuid|#4/);
    git("add", "b.txt"); git("commit", "-qm", "Remaining");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records.map(r => [r.workspaceId, r.turnNumber]), [["ws", 4]]);
    writeFileSync(resolve(cwd, "a.txt"), "unrelated\n"); git("add", "a.txt"); git("commit", "-qm", "Clean");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records, []);
    assert.deepEqual(parseGitProvenance("Threadex-author: threadex://ws/tx_task/uuid"), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("commit records only staged file associations; consumption is replay safe", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-provenance-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(resolve(cwd, "a.txt"), "a\n");
    writeFileSync(resolve(cwd, "b.txt"), "b\n");
    recordGitProvenance(cwd, "session-1", "turn-1", ["a.txt", "b.txt"], undefined, "default", 1);
    recordGitProvenance(cwd, "session-2", "turn-2", ["a.txt"], undefined, "default", 2);
    git("add", "a.txt");
    const message = resolve(cwd, ".git", "test-message");
    writeFileSync(message, "First commit\n");
    prepareGitProvenance(cwd, message);
    prepareGitProvenance(cwd, message);
    const firstLinks = parseGitProvenance(readFileSync(message, "utf8"));
    assert.equal(firstLinks.length, 2);
    assert.deepEqual(firstLinks.map(r => [r.sessionId, r.turnNumber]).sort(), [["session-1", 1], ["session-2", 2]]);
    assert.match(readFileSync(message, "utf8"), /Threadex-author: threadex:\/\/default\/session-1#1/);
    assert.doesNotMatch(readFileSync(message, "utf8"), /"files"/);
    git("commit", "-q", "-F", message);
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD", "a.txt").records.map(r => r.turnNumber).sort(), [1, 2]);
    assert.equal(inspectGitProvenance(cwd, "HEAD", "not-committed.txt").records.length, 0);
    finishGitProvenance(cwd);
    recordGitProvenance(cwd, "session-1", "turn-1", ["a.txt", "b.txt"], "edit-later", "default", 1);
    writeFileSync(resolve(cwd, "a.txt"), "new unrelated edit\n");
    git("add", "a.txt", "b.txt");
    writeFileSync(message, "Second commit\n");
    prepareGitProvenance(cwd, message);
    const records = parseGitProvenance(readFileSync(message, "utf8"));
    assert.equal(records.length, 1);
    assert.deepEqual(records.map(r => [r.sessionId, r.turnNumber]), [["session-1", 1]]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("partial staging retains an association for the remaining file edit", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-provenance-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(resolve(cwd, "a.txt"), "staged\n"); git("add", "a.txt");
    writeFileSync(resolve(cwd, "a.txt"), "remaining\n");
    recordGitProvenance(cwd, "session", "turn", ["a.txt"], undefined, "default", 1);
    const message = resolve(cwd, ".git", "test-message");
    writeFileSync(message, "Partial\n"); prepareGitProvenance(cwd, message);
    git("commit", "-q", "-F", message); finishGitProvenance(cwd);
    git("add", "a.txt"); writeFileSync(message, "Rest\n"); prepareGitProvenance(cwd, message);
    assert.equal(parseGitProvenance(readFileSync(message, "utf8")).length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("installed hooks annotate commits and preserve existing hooks", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-provenance-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", ".custom-hooks");
    installGitProvenanceHooks(cwd, fileURLToPath(new URL("../../scripts/git-provenance.ts", import.meta.url)), import.meta.resolve("tsx"));
    assert.throws(() => installGitProvenanceHooks(cwd, "unused", "unused"), /Existing hook preserved/);
    writeFileSync(resolve(cwd, "a.txt"), "content\n");
    recordGitProvenance(cwd, "local_test", "turn", ["a.txt"], undefined, "project-two", 12);
    git("add", "a.txt"); git("commit", "-q", "-m", "Hook integration");
    const linked = inspectGitProvenance(cwd, "HEAD").records[0];
    assert.equal(linked?.turnNumber, 12);
    assert.equal(linked?.workspaceId, "project-two");
    assert.deepEqual(parseCodexReference(linked?.url ?? ""), {
      uri: "threadex://project-two/tx_test#12", workspaceId: "project-two",
      target: "tx_test", turnNumbers: [12], lookupKind: "sessionId"
    });
    writeFileSync(resolve(cwd, "a.txt"), "unrelated\n");
    git("add", "a.txt"); git("commit", "-q", "-m", "Consumed");
    assert.equal(inspectGitProvenance(cwd, "HEAD").records.length, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("live edits support multiple commits within one turn without resurrecting replayed events", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-provenance-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const event = (id: string) => ({ id, sessionId: "session", turnId: "still-running", event: "item",
    data: { itemType: "file_change", eventType: "item.completed", status: "completed", changes: [{ path: "a.txt" }] } });
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    installGitProvenanceHooks(cwd, fileURLToPath(new URL("../../scripts/git-provenance.ts", import.meta.url)), import.meta.resolve("tsx"));
    writeFileSync(resolve(cwd, "a.txt"), "first\n"); recordLiveGitProvenance(cwd, event("edit-1"), "default", 1);
    git("add", "a.txt"); git("commit", "-q", "-m", "During turn");
    assert.equal(inspectGitProvenance(cwd, "HEAD").records[0]?.turnNumber, 1);
    recordLiveGitProvenance(cwd, event("edit-1"), "default", 1); // delayed server callback/replay
    writeFileSync(resolve(cwd, "a.txt"), "second\n"); recordLiveGitProvenance(cwd, event("edit-2"), "default", 1);
    git("add", "a.txt"); git("commit", "-q", "-m", "Same turn again");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records.map(r => [r.sessionId, r.turnNumber]), [["session", 1]]);
    recordLiveGitProvenance(cwd, event("edit-2"), "default", 1);
    writeFileSync(resolve(cwd, "a.txt"), "unrelated\n"); git("add", "a.txt"); git("commit", "-q", "-m", "No new event");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records, []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
