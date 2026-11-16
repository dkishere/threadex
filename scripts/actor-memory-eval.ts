import { readFileSync } from "node:fs";
import { actorMemoryDigestPrompt, actorMemoryMaintenancePrompt } from "../src/server/domainActorRunner";
import type { ActorMemoryContent } from "../src/domainActors";

type EvalCase = { id: string; memory: ActorMemoryContent; event?: unknown; summaries?: unknown[]; context: unknown };
const cases = JSON.parse(readFileSync(new URL("../src/server/fixtures/actorMemory.eval.json", import.meta.url), "utf8")) as EvalCase[];
const scenario = cases.find(item => item.id === process.argv[2]);
if (!scenario) {
  console.error(`Usage: node --import tsx scripts/actor-memory-eval.ts <${cases.map(item => item.id).join("|")}>`);
  process.exit(1);
}
// Emit the current production maintenance (or collective digest) prompt, without sending the grading rubric to the model.
console.log(scenario.summaries
  ? actorMemoryDigestPrompt({ memory: scenario.memory, summaries: scenario.summaries, baseVersion: 0, context: scenario.context })
  : actorMemoryMaintenancePrompt({ memory: scenario.memory, event: scenario.event, baseVersion: 0, context: scenario.context, runningSessions: [] }));
