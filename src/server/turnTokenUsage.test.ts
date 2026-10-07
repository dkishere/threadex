import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore.js";

test("turn totals restore historical usage, isolate turns and deduplicate telemetry", async () => {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "turn-usage-")), "test.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    for (const id of ["first", "resumed", "legacy", "reset", "reported", "uncached"]) {
      await store.recordSessionTurn({ id, sessionId: "session", userInput: id,
        agentResponse: "done", tokenIn: 102189, tokenOut: 115, status: "done" });
    }
    const sample = (turnId: string, source: string, index: number,
      inputTokens: number, outputTokens: number, cumulativeInputTokens: number, cumulativeOutputTokens: number,
      cachedInputTokens = 0, cumulativeCachedInputTokens = 0) => ({
      id: `${turnId}:${source}:${index}`, usageType: "agent" as const, sessionId: "session", turnId, source,
      sourceIndex: index, sourceTimestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      inputTokens, outputTokens, cumulativeInputTokens, cumulativeOutputTokens,
      cachedInputTokens, cumulativeCachedInputTokens
    });
    await store.recordTokenUsage([
      sample("first", "native_token_count", 1, 18909, 130, 18909, 130, 7168, 7168),
      sample("first", "native_token_count", 2, 102189, 115, 2642756, 18857, 100736, 2542592),
      // An inherited thread counter is not this turn's usage.
      sample("resumed", "app_server", 3, 200, 20, 2642956, 18877, 130, 2542722),
      sample("resumed", "app_server", 4, 300, 30, 2643256, 18907, 200, 2542922),
      sample("resumed", "app_server", 5, 300, 30, 2643256, 18907, 200, 2542922),
      sample("resumed", "native_token_count", 3, 200, 20, 2642956, 18877, 130, 2542722),
      sample("resumed", "native_token_count", 4, 300, 30, 2643256, 18907, 200, 2542922),
      { ...sample("resumed", "app_server", 6, 999, 999, 9999999, 9999999, 999, 9999999), usageType: "background" },
      sample("reset", "app_server", 1, 100, 10, 1000, 100, 80, 800),
      sample("reset", "app_server", 2, 50, 5, 50, 5),
      sample("reset", "app_server", 3, 60, 6, 110, 11, 40, 40),
      sample("reported", "native_token_count", 1, 1000, 10, 1000, 10),
      sample("reported", "native_token_count", 2, 58177, 106, 1226001, 4654, 57216, 1132416),
      sample("uncached", "app_server", 1, 100, 10, 100, 10)
    ]);
    const turns = await store.listSessionTurns("session");
    const totals = Object.fromEntries(turns.map(t => [t.id, [t.tokenIn, t.cachedInputTokens, t.tokenOut]]));
    assert.deepEqual(totals, { first: [2642756, 2542592, 18857], resumed: [500, 330, 50],
      legacy: [102189, undefined, 115], reset: [210, 120, 21],
      reported: [1226001, 1132416, 4654], uncached: [100, 0, 10] });
    const reported = await store.inspectSession({ sessionId: "session", turnId: "reported" });
    assert.equal(reported?.turns[0]?.cachedInputTokens, 1132416);
    assert.equal(reported?.turns[0]?.usageSample?.cachedInputTokens, 57216);
    const page = await store.listSessionsPage("default", 0, 10);
    const listed = page.sessions.find(s => s.id === "session");
    const expectedInput = turns.reduce((total, t) => total + t.tokenIn, 0);
    const expectedOutput = turns.reduce((total, t) => total + t.tokenOut, 0);
    assert.equal(listed?.tokenCount, expectedInput + expectedOutput);
    assert.deepEqual(listed?.modelTokenUsage, [{ model: "Unknown", tokenCount: expectedInput + expectedOutput,
      inputTokenCount: expectedInput, cachedInputTokenCount: 3675458, outputTokenCount: expectedOutput }]);
    const first = await store.getSessionTurn("first");
    assert.equal(first?.tokenOut, 18857);
    // The latest request still measures context load, not aggregate usage.
    assert.equal(first?.usageSample?.outputTokens, 115);
    assert.equal(first?.usageSample?.inputTokens, 102189);
    assert.equal(first?.cachedInputTokens, 2542592);
    // A subsequent result update must not regress the exposed total.
    await store.updateSessionTurn({ id: "first", agentResponse: "done", tokenIn: 102189, tokenOut: 115, status: "done" });
    assert.equal((await store.getSessionTurn("first"))?.tokenOut, 18857);
  } finally {
    await store.close();
  }
});
