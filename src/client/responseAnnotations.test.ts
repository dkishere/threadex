import assert from "node:assert/strict";
import test from "node:test";
import {
  formatResponseAnnotationsPrompt,
  parseResponseAnnotations,
  type ResponseAnnotation
} from "./responseAnnotations";

test("round-trips a response annotation source", () => {
  const annotation: ResponseAnnotation = {
    text: "selected response",
    annotation: "explain this",
    source: {
      type: "response",
      sessionUrl: "codex://workspace/thread_123",
      turnId: "turn-1",
      turnNumber: 2
    }
  };

  assert.deepEqual(parseResponseAnnotations(formatResponseAnnotationsPrompt([annotation], "more context")), {
    annotations: [annotation],
    content: "explain this\n\nmore context"
  });
});

test("round-trips a file annotation source", () => {
  const annotation: ResponseAnnotation = {
    text: "const answer = 42;",
    annotation: "rename this",
    source: {
      type: "file",
      path: "/workspace/src/answer.ts",
      selection: { startLine: 8, startColumn: 3, endLine: 8, endColumn: 21 },
      side: "modified",
      workspaceId: "workspace-1",
      sessionUrl: "codex://workspace-1/local_123"
    }
  };

  assert.deepEqual(parseResponseAnnotations(formatResponseAnnotationsPrompt([annotation])), {
    annotations: [annotation],
    content: "rename this"
  });
});

test("accepts legacy annotations without a source and legacy response sources", () => {
  const value = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([
      { text: "no source" },
      { text: "old source", source: { sessionUrl: "codex://workspace/thread", turnNumber: 3 } }
    ]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "request"
  ].join("\n");

  assert.deepEqual(parseResponseAnnotations(value), {
    annotations: [
      { text: "no source" },
      {
        text: "old source",
        source: { type: "response", sessionUrl: "codex://workspace/thread", turnNumber: 3 }
      }
    ],
    content: "request"
  });
});

test("malformed protocol falls back by returning null", () => {
  const malformed = "# Response annotations:\n<response-annotations>not json</response-annotations>\nrequest";
  assert.equal(parseResponseAnnotations(malformed), null);
});
