// Real detached worker and database, with only provider inference replaced.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IsolatedLunaRunner } from "../isolatedLunaRunner";

const directory = process.argv[2];
const cancellations = new WeakMap<IsolatedLunaRunner, () => void>();
IsolatedLunaRunner.prototype.run = async function () {
  appendFileSync(resolve(directory, "calls"), "actor\n");
  await new Promise<void>((done, reject) => {
    const timer = setInterval(() => {
      if (existsSync(resolve(directory, "release"))) { clearInterval(timer); done(); }
    }, 20);
    cancellations.set(this, () => { clearInterval(timer); reject(new Error("Stopped")); });
  });
  cancellations.delete(this);
  return { responseText: "Detached actor answer", usage: null, authIdentity: {} as any };
};
IsolatedLunaRunner.prototype.stop = function () { cancellations.get(this)?.(); };
const job = JSON.parse(readFileSync(resolve(directory, "job.json"), "utf8"));
if (job.kind === "side-chat") {
  // Use the real side-chat runner prompt and persistence, with the same gate.
  delete process.env.SESSION_QUESTION_MOCK_RESPONSE;
}
await import("../discussionWorker");
