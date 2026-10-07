import assert from "node:assert/strict";
import test from "node:test";
import type { TurnGrill } from "../turnGrill";
import { shouldReloadTurnGrill } from "./sessionApi";

test("Grill polling checks unchanged running jobs so interrupted workers can recover", () => {
  const review: TurnGrill = { revision: 5, status: "running", updated: "", issues: [], rounds: [], error: null };
  assert.equal(shouldReloadTurnGrill(true, review, 5), true);
  assert.equal(shouldReloadTurnGrill(true, review, 4), true);
  assert.equal(shouldReloadTurnGrill(true, { ...review, status: "ready" }, 5), false);
  assert.equal(shouldReloadTurnGrill(true, { ...review, status: "error" }, 5), false);
  assert.equal(shouldReloadTurnGrill(true, { ...review, status: "ready" }, 6), true);
  assert.equal(shouldReloadTurnGrill(false, null, 0), true);
  assert.equal(shouldReloadTurnGrill(true, null, 0), false);
});
