import { readFileSync } from "node:fs";
import { DEFAULT_MODEL } from "../src/modelCatalog";
import type { RoundtableRound } from "../src/roundtable";
import { roundtableHostInstructions, roundtableHostPrompt } from "../src/server/roundtableService";

type EvalCase = { id: string; topic: string; responses: { actor: string; text: string }[] };
const cases = JSON.parse(readFileSync(new URL("../src/server/fixtures/roundtableConclusion.eval.json", import.meta.url), "utf8")) as EvalCase[];
const scenario = cases.find(item => item.id === process.argv[2]);
if (!scenario) {
  console.error(`Usage: node --import tsx scripts/roundtable-conclusion-eval.ts <${cases.map(item => item.id).join("|")}>`);
  process.exit(1);
}
const round: RoundtableRound = {
  turnId: `rt_eval_${scenario.id}`, sessionId: "eval", revision: 1, prompt: scenario.topic,
  created: "2026-10-21T00:00:00.000Z", status: "host", context: null, summarizerModel: DEFAULT_MODEL,
  hostModel: DEFAULT_MODEL, hostEffort: "medium", summary: "", error: null, tokenIn: 0, tokenOut: 0,
  answers: scenario.responses.map((response, index) => ({
    actor: { id: `actor_${index}`, name: response.actor, model: DEFAULT_MODEL, effort: "high", systemPrompt: "" },
    status: "done", text: response.text, error: null
  }))
};
// Emit current production instructions, without sending the grading rubric to the model.
console.log(JSON.stringify([
  { role: "developer", content: roundtableHostInstructions(round) },
  { role: "user", content: roundtableHostPrompt(round) }
], null, 2));
