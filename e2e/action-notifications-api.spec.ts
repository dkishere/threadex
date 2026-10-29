import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson, postJson, runnerUpdate, startMockRunner } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";

test("global pending actions include source workspace and title for foreground and background sessions", async ({ page, request }) => {
  const sessionId = scenarioSessions.switchAlpha.id;
  const turnId = "notifications-api-turn";
  const records = [
    { approvalId: "notifications-api-command", sessionId, turnId, requestId: 901, method: "item/commandExecution/requestApproval", params: { command: "echo notification" } },
    { approvalId: "notifications-api-question", sessionId: "e2e-background-session", turnId: "e2e-background-turn", requestId: 902, method: "item/tool/requestUserInput",
      params: { isBlocking: false, questions: [{ id: "scope", header: "Scope", question: "Which scope?" }] } }
  ];
  await startMockRunner(request, { sessionId, turnId, message: "Notification API contract" });
  try {
    for (const record of records) await postJson(request, "/api/approvals/request", record);
    const payload = await checkedJson(await page.request.get(`${apiBaseUrl}/api/approvals`));
    expect(payload.approvals.find((item: any) => item.approvalId === records[0].approvalId)).toMatchObject({ workspaceId: "default", sessionTitle: scenarioSessions.switchAlpha.title, sessionId });
    expect(payload.approvals.find((item: any) => item.approvalId === records[1].approvalId)).toMatchObject({ workspaceId: "e2e-background", sessionTitle: "Background Active Session", sessionId: "e2e-background-session" });
    const filtered = await checkedJson(await page.request.get(`${apiBaseUrl}/api/approvals?sessionId=${sessionId}`));
    expect(filtered.approvals.every((item: any) => item.sessionId === sessionId)).toBe(true);
    await postJson(request, `/api/approvals/${records[0].approvalId}/decision`, { decision: "decline" });
    const after = await checkedJson(await page.request.get(`${apiBaseUrl}/api/approvals`));
    expect(after.approvals.some((item: any) => item.approvalId === records[0].approvalId)).toBe(false);
    expect(after.approvals.some((item: any) => item.approvalId === records[1].approvalId)).toBe(true);
  } finally {
    for (const record of records) await postJson(request, `/api/approvals/${record.approvalId}/decision`, { decision: "cancel" }).catch(() => {});
    await runnerUpdate(request, { id: `${turnId}:done`, sessionId, turnId, event: "result", data: { reply: "Complete" } });
  }
});

test("questions of a turn that stopped running expire and an orphaned runner cannot reopen them", async ({ page, request }) => {
  const sessionId = scenarioSessions.switchAlpha.id;
  const turnId = "notifications-api-orphan-turn";
  const record = { approvalId: "notifications-api-orphan-question", sessionId, turnId, requestId: "async:orphan", method: "item/tool/requestUserInput",
    params: { isBlocking: false, delivery: "async", questions: [{ id: "0", header: "Question 1", question: "Still needed?" }] } };
  await startMockRunner(request, { sessionId, turnId, message: "Orphan question contract" });
  await postJson(request, "/api/approvals/request", record);
  const listed = async () => (await checkedJson(await page.request.get(`${apiBaseUrl}/api/approvals?sessionId=${sessionId}`))).approvals
    .some((item: any) => item.approvalId === record.approvalId);
  expect(await listed()).toBe(true);

  await runnerUpdate(request, { id: `${turnId}:done`, sessionId, turnId, event: "result", data: { reply: "Complete" } });
  await expect.poll(listed).toBe(false);
  // The runner keeps re-registering every ~30s; its turn is gone, so nothing reopens.
  const reopened = await request.post(`${apiBaseUrl}/api/approvals/request`, { data: record });
  expect(reopened.status()).toBe(409);
  expect(await reopened.json()).toMatchObject({ stale: true, expired: true });
  expect(await listed()).toBe(false);
  const answered = await request.post(`${apiBaseUrl}/api/approvals/${record.approvalId}/decision`, { data: { decision: { answers: { "0": { answers: ["yes"] } } } } });
  expect(answered.status()).toBe(409);
});

test("decisions for approvals the server no longer waits on are rejected", async ({ request }) => {
  const sessionId = scenarioSessions.switchAlpha.id;
  const turnId = "notifications-api-expired-turn";
  const record = { approvalId: "notifications-api-expired", sessionId, turnId, requestId: 903, method: "item/commandExecution/requestApproval", params: { command: "echo expired" } };
  await startMockRunner(request, { sessionId, turnId, message: "Expired approval contract" });
  try {
    // Not held, e.g. after a server restart: nothing can receive the decision.
    const unknown = await request.post(`${apiBaseUrl}/api/approvals/notifications-api-never-registered/decision`, { data: { decision: "accept" } });
    expect(unknown.status()).toBe(409);
    expect(await unknown.json()).toMatchObject({ stale: true });

    await postJson(request, "/api/approvals/request", record);
    await postJson(request, `/api/approvals/${record.approvalId}/decision`, { decision: "decline" });
    const again = await request.post(`${apiBaseUrl}/api/approvals/${record.approvalId}/decision`, { data: { decision: "acceptForSession" } });
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ stale: true });
  } finally {
    await runnerUpdate(request, { id: `${turnId}:done`, sessionId, turnId, event: "result", data: { reply: "Complete" } });
  }
});
