import type { Page } from "@playwright/test";
import { grillAwaitingAck, type TurnGrill } from "../../src/turnGrill";

export async function mockGrillSummaries(page: Page, sessionId: string, read: () => TurnGrill | null, turnId = `${sessionId}-baseline`) {
  await page.route(/\/api\/(workspace\/snapshot|events\?[^/]+)$/, async (route) => {
    const response = await route.fetch();
    const saved = read();
    await route.fulfill({ response, json: { ...await response.json(), grillSummaries: saved
      ? [{ sessionId, turnId, revision: saved.revision, pending: grillAwaitingAck(saved) }] : [] } });
  });
}
