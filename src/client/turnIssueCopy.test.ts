import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTurnIssueCopyPayload,
  parseTurnIssueContext,
  serializeTurnIssueCopy,
  turnIssueContextAttachmentName
} from "./turnIssueCopy.js";

test("blocker context round-trips without marking the issue resolved", () => {
  const payload = buildTurnIssueCopyPayload({ id: "codex", workspaceId: "workspace", sessionId: "session",
    turnId: "turn", issueKey: 1, issue: "Deploy unavailable", solution: null, blocker: "Credentials required" });
  assert.equal(payload.resolved, false);
  assert.equal(payload.blocker, "Credentials required");
  assert.deepEqual(parseTurnIssueContext(JSON.stringify(payload)), payload);
  assert.equal(parseTurnIssueContext(JSON.stringify({ ...payload, resolved: true, solution: "Fixed" })), null);
});

test("builds a traceable payload for one resolved issue", () => {
  assert.deepEqual(buildTurnIssueCopyPayload({
    id: "codex-session-123",
    workspaceId: "threadex workspace",
    sessionId: "local_session-1",
    turnId: "turn-7",
    issueKey: 2,
    issue: "The issue ledger lost its turn identity",
    solution: "Pass the owning turn ID into the tracker"
  }), {
    kind: "threadex-issue-context",
    cli: "codex",
    id: "codex-session-123",
    sessionUrl: "codex://threads/local_session-1?workspace=threadex+workspace",
    workspaceId: "threadex workspace",
    sessionId: "local_session-1",
    turnId: "turn-7",
    issueKey: 2,
    issue: "The issue ledger lost its turn identity",
    resolved: true,
    solution: "Pass the owning turn ID into the tracker"
  });
});

test("serializes one unresolved issue as pretty JSON with a null solution", () => {
  const json = serializeTurnIssueCopy({
    id: "codex-session-456",
    workspaceId: "threadex",
    sessionId: "local_session-2",
    turnId: "turn-8",
    issueKey: 1,
    issue: "Clipboard feedback is missing",
    solution: null
  });

  assert.equal(json, `{
  "kind": "threadex-issue-context",
  "cli": "codex",
  "id": "codex-session-456",
  "sessionUrl": "codex://threads/local_session-2?workspace=threadex",
  "workspaceId": "threadex",
  "sessionId": "local_session-2",
  "turnId": "turn-8",
  "issueKey": 1,
  "issue": "Clipboard feedback is missing",
  "resolved": false,
  "solution": null
}`);
  assert.deepEqual(JSON.parse(json), {
    kind: "threadex-issue-context",
    cli: "codex",
    id: "codex-session-456",
    sessionUrl: "codex://threads/local_session-2?workspace=threadex",
    workspaceId: "threadex",
    sessionId: "local_session-2",
    turnId: "turn-8",
    issueKey: 1,
    issue: "Clipboard feedback is missing",
    resolved: false,
    solution: null
  });
});

test("parses copied issue JSON as composer context", () => {
  const json = serializeTurnIssueCopy({
    id: "codex-session-456",
    workspaceId: "threadex",
    sessionId: "local_session-2",
    turnId: "turn/8",
    issueKey: 3,
    issue: "Paste handling is missing",
    solution: "Recognize the issue context kind"
  });
  const context = parseTurnIssueContext(json);

  assert.equal(context?.kind, "threadex-issue-context");
  assert.equal(turnIssueContextAttachmentName(context!), "threadex-issue-turn-8-3.json");
});

test("rejects inconsistent or unrelated issue context JSON", () => {
  const payload = buildTurnIssueCopyPayload({
    id: "codex-session-456",
    workspaceId: "threadex",
    sessionId: "local_session-2",
    turnId: "turn-8",
    issueKey: 1,
    issue: "Paste handling is missing",
    solution: null
  });

  assert.equal(parseTurnIssueContext(JSON.stringify({ ...payload, kind: "issue" })), null);
  assert.equal(parseTurnIssueContext(JSON.stringify({ ...payload, cli: "claude" })), null);
  assert.equal(parseTurnIssueContext(JSON.stringify({ ...payload, resolved: true })), null);
  assert.equal(parseTurnIssueContext(JSON.stringify({ ...payload, sessionUrl: "codex://threads/other?workspace=threadex" })), null);
});
