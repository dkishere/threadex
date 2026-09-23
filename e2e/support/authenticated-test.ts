import { test as base, expect } from "@playwright/test";
import { apiBaseUrl } from "./mock-runner";

// Credentials belong only to the disposable E2E server's data directory.
let token: string | undefined;
export const test = base.extend({
  page: async ({ page }, use) => {
    if (!token) {
      const status = await (await page.request.get(`${apiBaseUrl}/api/security/status`)).json();
      const response = await page.request.post(`${apiBaseUrl}/api/security/${status.configured ? "login" : "password"}`, {
        data: { password: "Threadex feature test password" }
      });
      expect(response.ok()).toBe(true);
      token = (await response.json()).token;
    }
    const restored = await page.request.post(`${apiBaseUrl}/api/security/restore`, { data: { token } });
    expect(restored.ok()).toBe(true);
    await use(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
export { expect };
