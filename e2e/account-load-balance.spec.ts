import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { SessionStore } from "../src/server/sessionStore";
import { apiBaseUrl, e2eDataDir, postJson, runnerUpdate } from "./support/mock-runner";

for (const scenario of [
  { name: "manual account", enabled: false, savedLoadBalance: false },
  { name: "LB disabled after submission", enabled: false, savedLoadBalance: true },
  { name: "LB enabled", enabled: true, savedLoadBalance: true }
]) {
  test(`usage-limit routing respects default workspace LB: ${scenario.name}`, async ({ request }) => {
    const store = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
    await store.ready();
    const suffix = scenario.name.replaceAll(" ", "-");
    const sessionId = `tx_lb_${suffix}`;
    const turnId = `${sessionId}-limited`;
    const holdId = `${sessionId}-held`;
    const originalId = `${sessionId}-original`;
    const alternateId = `${sessionId}-alternate`;
    try {
      for (const [id, usedPercent] of [[originalId, 100], [alternateId, 0]] as const) {
        await store.upsertAccount({ id, name: id, quotaSnapshot: {
          primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }
        } });
        await store.setAccountAuth(id, '{"OPENAI_API_KEY":"e2e-placeholder"}', null);
        await store.bindWorkspaceAccount("default", id);
      }
      await postJson(request, "/api/accounts/auto-load-balance", {
        workspaceId: "default", enabled: scenario.enabled
      });
      await store.switchAccount(originalId, "default");
      await store.upsertSession({
        id: sessionId, threadId: `thread-${sessionId}`, workspaceId: "default",
        accountId: originalId, cwd: e2eDataDir
      });
      await store.recordSessionTurn({
        id: turnId, sessionId, accountId: originalId, userInput: "Continue the task",
        agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running",
        pendingLoadBalance: scenario.savedLoadBalance,
        requestMetadata: { loadBalanceInWorkspace: scenario.savedLoadBalance, workspaceId: "default" }
      });
      // Hold a queued prompt so the scheduler cannot launch a real Codex runner.
      // Account routing and request preparation still run through the real API.
      await store.recordSessionTurn({
        id: holdId, sessionId, accountId: originalId, userInput: "Held for editing",
        agentResponse: "", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued"
      });
      await store.reservePendingSessionTurnForEdit(holdId, sessionId, "e2e-hold");

      await runnerUpdate(request, {
        id: `${turnId}-limit`, sessionId, turnId, event: "pending",
        data: { reason: "rate_limit", message: "Usage limit reached" }
      });
      expect(await store.getSessionTurn(turnId)).toMatchObject({
        status: "todo", pendingReason: "rate_limit", pendingLoadBalance: scenario.enabled
      });
      if (scenario.enabled) {
        await expect.poll(async () => (await store.getSession(sessionId))?.accountId).toBe(alternateId);
      } else {
        // Replay the saved turn settings through the automatic retry endpoint.
        // The edit hold prevents runner startup after request preparation.
        const retry = await request.post(`${apiBaseUrl}/api/chat`, {
          headers: { "X-Threadex-Automatic-Pending": "1" },
          data: { retryPending: true, sessionId, turnId, workspaceId: "default" }
        });
        expect(retry.ok()).toBe(true);
        expect(await retry.text()).toContain("Still queued behind the active turn.");
        expect((await store.getSession(sessionId))?.accountId).toBe(originalId);
      }
      const accounts = await (await request.get(`${apiBaseUrl}/api/accounts`)).json();
      expect(accounts.loadBalanceInWorkspace).toBe(scenario.enabled);
      expect(accounts.activeAccount.id).toBe(scenario.enabled ? alternateId : originalId);
      expect((await store.getSession(sessionId))?.threadId).toBe(`thread-${sessionId}`);
    } finally {
      for (const id of [turnId, holdId]) {
        await store.updateSessionTurn({ id, agentResponse: "Test finished", tokenIn: 0, tokenOut: 0, status: "done" });
        await store.cancelWaitSubscriptionsForTurn(id);
      }
      await postJson(request, "/api/accounts/auto-load-balance", { workspaceId: "default", enabled: false });
      for (const id of [originalId, alternateId]) await store.deleteAccount(id);
      await store.close();
    }
  });
}
