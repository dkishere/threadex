import { expect, test } from "@playwright/test";

test("Quick Chat selects a session and sends an immutable ChatGPT preset", async ({page}) => {
  const session = {id:"session-a", accountId:"account-a", title:"Existing chat", messages:[{id:"old",role:"assistant",text:"Earlier reply"}]};
  await page.route("**/api/quick-chat/status", route => route.fulfill({json:{accounts:[{id:"account-a",label:"App account"}],models:[{id:"instant",label:"Instant"},{id:"thinking",label:"Thinking"}]}}));
  await page.route("**/api/quick-chat/sessions?*", route => route.fulfill({json:{sessions:[session]}}));
  let sent: any;
  await page.route("**/api/quick-chat/messages", async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({json:{session:{...session,messages:[...session.messages,{id:"user",role:"user",text:sent.prompt},{id:"reply",role:"assistant",text:"Quick reply"}]}}});
  });
  await page.goto("/e2e/support/quick-chat.html");
  await expect(page.getByLabel("Quick Chat account")).toHaveValue("account-a");
  await page.getByLabel("Quick Chat session").selectOption("session-a");
  await expect(page.getByText("Earlier reply")).toBeVisible();
  await page.locator(".composer-gear-radio").filter({hasText:"Thinking"}).click();
  await expect(page.getByRole("radio", {name:"Thinking",exact:true})).toBeChecked();
  await expect(page.locator(".composer-gear-edit")).toHaveCount(0);
  await page.getByRole("textbox").fill("Hello from the panel");
  await page.getByRole("button", {name:"Send quick chat"}).click();
  await expect(page.getByText("Quick reply")).toBeVisible();
  expect(sent).toEqual({accountId:"account-a",sessionId:"session-a",model:"thinking",prompt:"Hello from the panel"});
  await page.getByRole("button", {name:"New quick chat"}).click();
  await expect(page.getByLabel("Quick Chat session")).toHaveValue("");
  await expect(page.getByText("Earlier reply")).toHaveCount(0);
});

test("Quick Chat shows connection errors and prevents sends without an App account", async ({page}) => {
  await page.route("**/api/quick-chat/status", route => route.fulfill({json:{accounts:[],models:[],error:"ChatGPT App background connection is unavailable."}}));
  await page.goto("/e2e/support/quick-chat.html");
  await expect(page.getByRole("alert")).toContainText("background connection is unavailable");
  await page.getByRole("textbox").fill("Keep this draft");
  await expect(page.getByRole("button", {name:"Send quick chat"})).toBeDisabled();
});
