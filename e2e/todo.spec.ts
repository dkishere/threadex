import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiBaseUrl, checkedJson, runnerUpdate, selectSession, startMockRunner } from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

type TodoSnapshot = {
  sessionId: string;
  control: {
    sessionId: string;
    paused: boolean;
    pauseReason: string | null;
    pausedBy: "agent" | "user" | "system" | null;
    updated: string;
  };
  items: Array<{
    id: string;
    sessionId: string;
    parentId: string | null;
    title: string;
    details: string;
    status: string;
    position: number;
    createdBy: string;
    updatedBy: string;
    lockedByTurnId: string | null;
    lockReason: string | null;
    activeStatus: string | null;
    changedFileCount: number;
    changedFiles: string[];
    created: string;
    updated: string;
  }>;
  comments: Array<{
    id: string;
    sessionId: string;
    itemId: string | null;
    type: string;
    author: string;
    body: string;
    created: string;
  }>;
  messages: Array<{
    id: number;
    sessionId: string;
    itemId: string;
    turnId: string | null;
    type: "update" | "challenge";
    author: string;
    title: string;
    body: string;
    challengeId: number | null;
    resolved: boolean;
    resolvedAt: string | null;
    created: string;
  }>;
};

async function getTodo(request: APIRequestContext, sessionId: string) {
  return checkedJson(await request.get(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos`)) as Promise<TodoSnapshot>;
}

async function createTodoTestSession(request: APIRequestContext, title: string) {
  const response = await request.post(`${apiBaseUrl}/api/sessions/fork`, {
    data: {
      sessionId: scenarioSessions.bootstrap.id,
      turnId: `${scenarioSessions.bootstrap.id}-baseline`,
      title
    }
  });
  expect(response.status()).toBe(200);
  const payload = await response.json() as { session: { id: string; title: string } };
  expect(payload.session.title).toBe(title);
  return payload.session;
}

async function answerDialogs(page: Page, answers: string[], action: () => Promise<void>) {
  const pending = [...answers];
  const seen: string[] = [];
  const handler = async (dialog: Parameters<Page["on"]>[1] extends (dialog: infer Dialog) => unknown ? Dialog : never) => {
    seen.push(dialog.message());
    await dialog.accept(pending.shift() ?? "");
  };
  page.on("dialog", handler);
  try {
    await action();
    await expect.poll(() => seen.length).toBe(answers.length);
    expect(pending).toHaveLength(0);
  } finally {
    page.off("dialog", handler);
  }
}

test("legacy clarification does not force the lightweight composer toggle on", async ({ page, request }) => {
  const session = await createTodoTestSession(request, "Todo Grill Follow-up E2E Session");
  await checkedJson(await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(session.id)}/todos/control`, {
    data: {
      paused: true,
      pauseReason: "Todo MCP plan needs clarification before it can be created.",
      context: JSON.stringify({ clarificationQuestions: ["Which outcome matters most?"] }),
      actor: "agent"
    }
  }));

  let submittedForcePlan: boolean | null = null;
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { sessionId: string; turnId: string; forcePlan?: boolean };
    submittedForcePlan = body.forcePlan === true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        `event: session\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          message: "Mock grill-me follow-up started"
        })}`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          elapsedMs: 10,
          reply: "Todo plan created from the answers"
        })}`,
        "event: done\ndata: {\"ok\":true}"
      ].join("\n\n") + "\n\n"
    });
  });

  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const planMode = page.getByRole("button", { name: "Track outcomes" });
  await expect(planMode).toBeVisible();
  await expect(planMode).toHaveAttribute("aria-pressed", "false");
  await expect(planMode).toHaveAttribute("title", "Track outcomes with automatic status updates");
  await planMode.click();
  await expect(planMode).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("textbox", { name: "Message" }).fill("The primary outcome is a reliable release with no manual steps.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submittedForcePlan).toBe(true);
});

test("todo API creates nested items, comments, and pause control", async ({ request }) => {
  const session = await createTodoTestSession(request, "Todo API E2E Session");
  const sessionId = session.id;

  const emptyTodo = await getTodo(request, sessionId);
  expect(emptyTodo).toMatchObject({
    sessionId,
    control: { sessionId, paused: false, pauseReason: null, pausedBy: null },
    items: [],
    comments: [],
    messages: []
  });

  const rootResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/items`, {
    data: {
      id: "e2e-api-root",
      title: "API root item",
      details: "Created by Playwright API test",
      status: "active",
      actor: "agent",
      turnId: `${sessionId}-baseline`,
      activeStatus: "Working from API"
    }
  });
  expect(rootResponse.status()).toBe(201);
  const withRoot = await rootResponse.json() as TodoSnapshot;
  expect(withRoot.items).toHaveLength(1);
  expect(withRoot.items[0]).toMatchObject({
    id: "e2e-api-root",
    sessionId,
    parentId: null,
    title: "API root item",
    details: "Created by Playwright API test",
    status: "active",
    createdBy: "agent",
    updatedBy: "agent",
    lockedByTurnId: `${sessionId}-baseline`,
    activeStatus: "Working from API"
  });

  const childResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/items`, {
    data: {
      id: "e2e-api-child",
      parentId: "e2e-api-root",
      title: "API child item",
      details: "Nested under API root",
      actor: "user"
    }
  });
  expect(childResponse.status()).toBe(201);
  const withChild = await childResponse.json() as TodoSnapshot;
  expect(withChild.items.map((item) => [item.id, item.parentId, item.status])).toEqual([
    ["e2e-api-root", null, "active"],
    ["e2e-api-child", "e2e-api-root", "todo"]
  ]);

  const commentResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/comments`, {
    data: {
      itemId: "e2e-api-child",
      type: "blocker",
      author: "user",
      body: "Waiting on API verification"
    }
  });
  expect(commentResponse.status()).toBe(201);
  const withComment = await commentResponse.json() as TodoSnapshot;
  expect(withComment.comments).toEqual([
    expect.objectContaining({
      sessionId,
      itemId: "e2e-api-child",
      type: "blocker",
      author: "user",
      body: "Waiting on API verification"
    })
  ]);

  const updateMessageResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/messages`, {
    data: {
      itemId: "e2e-api-root",
      title: "API update message"
    }
  });
  expect(updateMessageResponse.status()).toBe(201);
  const withUpdateMessage = await updateMessageResponse.json() as TodoSnapshot & { message: TodoSnapshot["messages"][number] };
  expect(withUpdateMessage.message).toMatchObject({
    id: 1,
    itemId: "e2e-api-root",
    type: "update",
    title: "API update message",
    resolved: true
  });

  const challengeResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/messages`, {
    data: {
      itemId: "e2e-api-root",
      type: "challenge",
      title: "API challenge message",
      body: "Need user-visible challenge state"
    }
  });
  expect(challengeResponse.status()).toBe(201);
  const withChallenge = await challengeResponse.json() as TodoSnapshot & { challengeId: number };
  expect(withChallenge.challengeId).toBe(2);
  expect(withChallenge.messages.find((message) => message.id === 2)).toMatchObject({
    type: "challenge",
    challengeId: 2,
    resolved: false
  });

  const unresolved = await checkedJson(await request.get(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/challenges/unresolved`)) as { challenges: TodoSnapshot["messages"] };
  expect(unresolved.challenges.map((message) => message.id)).toEqual([2]);

  const resolveChallengeResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/challenges/2/resolve`, {
    data: { actor: "agent" }
  });
  expect(resolveChallengeResponse.status()).toBe(200);
  const resolvedChallenge = await resolveChallengeResponse.json() as TodoSnapshot & { resolvedChallengeId: number };
  expect(resolvedChallenge.resolvedChallengeId).toBe(2);
  expect(resolvedChallenge.messages.find((message) => message.id === 2)?.resolved).toBe(true);

  const pauseResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
    data: { paused: true, pauseReason: "API pause", actor: "user" }
  });
  expect(pauseResponse.status()).toBe(200);
  const paused = await pauseResponse.json() as TodoSnapshot;
  expect(paused.control).toMatchObject({ sessionId, paused: true, pauseReason: "API pause", pausedBy: "user" });

  const runnerControl = await checkedJson(await request.get(
    `${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/runner-control?turnId=${encodeURIComponent(`${sessionId}-baseline`)}`
  )) as { pause: boolean; reason: string; control: TodoSnapshot["control"] };
  expect(runnerControl).toMatchObject({
    pause: true,
    reason: "API pause",
    control: { sessionId, paused: true, pauseReason: "API pause", pausedBy: "user" }
  });

  const resumeResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
    data: { paused: false, actor: "user" }
  });
  expect(resumeResponse.status()).toBe(200);
  const resumed = await resumeResponse.json() as TodoSnapshot;
  expect(resumed.control).toMatchObject({ sessionId, paused: false, pauseReason: null, pausedBy: null });

  const fetched = await getTodo(request, sessionId);
  expect(fetched.items).toHaveLength(2);
  expect(fetched.comments).toHaveLength(1);
  expect(fetched.control.paused).toBe(false);
});

test("todo worker follow-ups reuse the existing task unless the user explicitly forks", async ({ request }) => {
  const parent = await createTodoTestSession(request, "Todo Worker Follow-up Guard");
  const itemResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(parent.id)}/todos/items`, {
    data: {
      id: "e2e-worker-item",
      title: "Worker-owned item",
      actor: "agent"
    }
  });
  expect(itemResponse.status()).toBe(201);

  const firstTaskResponse = await request.post(`${apiBaseUrl}/api/session-tasks`, {
    data: {
      parentSessionId: parent.id,
      sourceSessionId: parent.id,
      todoItemId: "e2e-worker-item",
      prompt: "Execute the assigned Todo item"
    }
  });
  expect(firstTaskResponse.status()).toBe(202);
  const firstTask = await firstTaskResponse.json() as { sessionId: string };

  const duplicateItemResponse = await request.post(`${apiBaseUrl}/api/session-tasks`, {
    data: {
      parentSessionId: parent.id,
      sourceSessionId: parent.id,
      todoItemId: "e2e-worker-item",
      prompt: "Create another worker for the same Todo item"
    }
  });
  expect(duplicateItemResponse.status()).toBe(409);
  expect(await duplicateItemResponse.json()).toMatchObject({
    sessionId: firstTask.sessionId,
    parentSessionId: parent.id,
    todoItemId: "e2e-worker-item"
  });

  const ordinaryFollowupResponse = await request.post(`${apiBaseUrl}/api/session-tasks`, {
    data: {
      parentSessionId: parent.id,
      sourceSessionId: firstTask.sessionId,
      prompt: "Move this ordinary worker follow-up into a new task"
    }
  });
  expect(ordinaryFollowupResponse.status()).toBe(409);
  expect(await ordinaryFollowupResponse.json()).toMatchObject({
    sessionId: firstTask.sessionId,
    parentSessionId: parent.id,
    todoItemId: "e2e-worker-item"
  });

  const explicitForkResponse = await request.post(`${apiBaseUrl}/api/session-tasks`, {
    data: {
      parentSessionId: firstTask.sessionId,
      sourceSessionId: firstTask.sessionId,
      contextFork: true,
      prompt: "Explicitly fork an independent child task"
    }
  });
  expect(explicitForkResponse.status()).toBe(202);
  expect(await explicitForkResponse.json()).toMatchObject({
    parentSessionId: firstTask.sessionId
  });
});

test("todo UI renders and updates items, comments, and pause control", async ({ page, request }) => {
  const session = await createTodoTestSession(request, "Todo UI E2E Session");
  const sessionId = session.id;
  await selectSession(request, sessionId);

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(session.title);

  const panel = page.locator(".todo-panel");
  await expect(panel).toHaveCount(0);

  const mockTurnId = `${sessionId}-todo-ui-files`;
  await startMockRunner(request, { sessionId, turnId: mockTurnId, message: "Todo UI file count turn" });

  const rootResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/items`, {
    data: {
      title: "UI root item",
      details: "Created through API to trigger todo panel",
      status: "active",
      actor: "agent",
      turnId: mockTurnId
    }
  });
  expect(rootResponse.status()).toBe(201);
  const rootTodo = await rootResponse.json() as TodoSnapshot;
  const rootItemId = rootTodo.items[0].id;
  await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/messages`, {
    data: {
      itemId: rootItemId,
      title: "Older update message",
      body: "This only appears after expanding history"
    }
  });
  const challengeResponse = await request.post(`${apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/todos/messages`, {
    data: {
      itemId: rootItemId,
      type: "challenge",
      title: "Latest challenge message",
      body: "Challenge details are highlighted"
    }
  });
  expect(challengeResponse.status()).toBe(201);
  await runnerUpdate(request, {
    id: `${mockTurnId}:file-change`,
    sessionId,
    turnId: mockTurnId,
    event: "item",
    data: {
      id: `${mockTurnId}:files`,
      itemType: "file_change",
      eventType: "item.completed",
      changes: [
        { path: "src/client/App.runtime.js", kind: "update" },
        { path: "src/client/styles.css", kind: "update" }
      ]
    }
  });
  await page.reload();
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  await expect(panel).toBeVisible();

  const rootItem = panel.locator(".todo-item").nth(0);
  const rootMain = rootItem.locator(".todo-item-main").first();
  await expect(rootMain.locator(".todo-item-copy strong")).toHaveText("UI root item");
  await expect(rootItem).toContainText("Created through API to trigger todo panel");
  await expect(rootMain.locator(".todo-status-label")).toHaveText("active");
  await expect(rootMain.locator(".todo-file-count")).toHaveText("2 files");
  const messageHistory = rootItem.locator(".todo-message-history").first();
  await expect(messageHistory.locator("summary .todo-message")).toContainText("Latest challenge message");
  await expect(messageHistory.locator("summary .todo-message")).toHaveAttribute("data-type", "challenge");
  await expect(rootItem.locator(".todo-message-list .todo-message").filter({ hasText: "Older update message" })).toBeHidden();
  await messageHistory.locator("summary").click();
  await expect(rootItem.locator(".todo-message-list .todo-message").filter({ hasText: "Older update message" })).toBeVisible();
  await expect(rootItem.locator(".todo-message-list .todo-message").filter({ hasText: "Latest challenge message" })).toBeVisible();
  await rootItem.getByRole("button", { name: "Resolve" }).click();
  await expect(rootItem.locator(".todo-message-list .todo-message").filter({ hasText: "Latest challenge message" })).toHaveAttribute("data-resolved", "true");

  await rootMain.getByLabel("Open todo item actions").click();
  await answerDialogs(page, ["UI child item", "Nested from the Todo panel"], async () => {
    await rootMain.getByRole("button", { name: "Add child", exact: true }).click();
  });
  const childItem = panel.locator(".todo-item").nth(1);
  const childMain = childItem.locator(".todo-item-main").first();
  await expect(childMain.locator(".todo-item-copy strong")).toHaveText("UI child item");
  await expect(childItem).toContainText("Nested from the Todo panel");

  await rootMain.getByLabel("Open todo item actions").click();
  await rootMain.getByRole("button", { name: "Edit", exact: true }).click();
  const editPopover = page.locator(".todo-edit-popover");
  await editPopover.getByPlaceholder("Todo title").fill("Edited UI root");
  await editPopover.getByPlaceholder("Details").fill("Edited details from dialog");
  await editPopover.getByRole("button", { name: "Save", exact: true }).click();
  const editedRoot = panel.locator(".todo-item").nth(0);
  const editedRootMain = editedRoot.locator(".todo-item-main").first();
  await expect(editedRootMain.locator(".todo-item-copy strong")).toHaveText("Edited UI root");
  await expect(editedRoot).toContainText("Edited details from dialog");

  await editedRootMain.getByLabel("Open todo item actions").click();
  await editedRootMain.getByRole("button", { name: "Hold", exact: true }).click();
  await expect(editedRootMain.locator(".todo-status-label")).toHaveText("hold");

  await childMain.getByLabel("Open todo item actions").click();
  await childMain.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(childMain.locator(".todo-status-label")).toHaveText("skipped");

  await childMain.getByLabel("Open todo item actions").click();
  await childMain.getByRole("button", { name: "Done", exact: true }).click();
  await expect(childMain.locator(".todo-status-label")).toHaveText("done");

  await editedRootMain.getByLabel("Open todo item actions").click();
  await answerDialogs(page, ["UI note comment"], async () => {
    await editedRootMain.getByRole("button", { name: "Comment", exact: true }).click();
  });
  await expect(editedRoot.locator(".todo-comment")).toContainText("note: UI note comment");

  await editedRootMain.getByLabel("Open todo item actions").click();
  await answerDialogs(page, ["UI blocker comment"], async () => {
    await editedRootMain.getByRole("button", { name: "Blocker", exact: true }).click();
  });
  await expect(editedRoot.locator(".todo-comment").filter({ hasText: "blocker: UI blocker comment" })).toBeVisible();

  await answerDialogs(page, ["UI pause reason"], async () => {
    await panel.getByRole("button", { name: "Pause" }).click();
  });
  await expect(panel).toContainText("Paused: UI pause reason");
  await expect(panel.getByRole("button", { name: "Resume" })).toBeVisible();

  await panel.getByRole("button", { name: "Resume" }).click();
  await expect(panel.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(panel).not.toContainText("Paused: UI pause reason");

  const todo = await getTodo(request, sessionId);
  expect(todo.control.paused).toBe(false);
  expect(todo.items.map((item) => ({
    title: item.title,
    details: item.details,
    parentId: item.parentId,
    status: item.status
  }))).toEqual([
    expect.objectContaining({
      title: "Edited UI root",
      details: "Edited details from dialog",
      parentId: null,
      status: "hold"
    }),
    expect.objectContaining({
      title: "UI child item",
      details: "Nested from the Todo panel",
      status: "done"
    })
  ]);
  const root = todo.items.find((item) => item.title === "Edited UI root");
  expect(root).toBeTruthy();
  expect(todo.items.find((item) => item.title === "UI child item")?.parentId).toBe(root?.id);
  expect(todo.comments.map((comment) => [comment.itemId, comment.type, comment.body])).toEqual([
    [root?.id, "note", "UI note comment"],
    [root?.id, "blocker", "UI blocker comment"]
  ]);
});


test("lightweight outcomes persist nested content and reject status and stale agent writes", async ({ page, request }) => {
  const session = await createTodoTestSession(request, "Lightweight outcome E2E");
  const url = `${apiBaseUrl}/api/sessions/${session.id}/outcome-plan`;
  const created = await checkedJson(await request.post(url, { data: {
    baseRevision: 0, objective: "Completed outcomes survive reload",
    items: [{ title: "Outcome display", acceptance: "Visible after reload", children: [{ title: "Nested outcome", acceptance: "Child stays under parent" }] }]
  } }));
  expect(created.plan.items[0].children).toHaveLength(1);
  expect((await request.post(url, { data: { baseRevision: 0, objective: "stale", items: [] } })).status()).toBe(409);
  expect((await request.post(url, { data: { baseRevision: 1, objective: "bad status", items: [{ ...created.plan.items[0], status: "done" }] } })).status()).toBe(400);
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const panel = page.getByRole("region", { name: "Outcome plan" });
  await expect(panel.getByText("Nested outcome", { exact: true })).toBeVisible();
  await expect(panel.getByText("Pending", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Track outcomes" })).toBeVisible();
  await panel.locator("li > details > summary").first().click();
  await expect(panel.getByText("Nested outcome", { exact: true })).not.toBeVisible();
  await page.reload();
  await expect(panel.getByText("Nested outcome", { exact: true })).toBeVisible();
});
