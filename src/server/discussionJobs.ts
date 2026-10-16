import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DiscussionJob = {
  id: string;
  sessionId: string;
  kind: "roundtable" | "side-chat";
  created: string;
  payload: Record<string, any>;
};
export type DiscussionJobState = { status: "running" | "done" | "error" | "stopped"; error?: string };

export function writeJobJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
export function readJobJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The server observes these workers; it does not own their lifetime. No account secrets go in jobs. */
export class DiscussionJobs {
  constructor(readonly directory: string, private worker = fileURLToPath(new URL("./discussionWorker.ts", import.meta.url))) {}
  path(sessionId: string, id: string) {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return resolve(this.directory, hash(sessionId), hash(id));
  }
  list(sessionId: string): DiscussionJob[] {
    const directory = dirname(this.path(sessionId, ""));
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap(name => {
      const job = readJobJson<DiscussionJob>(resolve(directory, name, "job.json"));
      return job?.sessionId === sessionId ? [job] : [];
    });
  }
  state(job: DiscussionJob): DiscussionJobState {
    const path = this.path(job.sessionId, job.id);
    const state = readJobJson<DiscussionJobState>(resolve(path, "state.json"));
    if (state && state.status !== "running") return state;
    const owner = readJobJson<{ pid: number; heartbeat?: number }>(resolve(path, "owner.json"));
    if (owner && alive(owner.pid) && Date.now() - (owner.heartbeat ?? Date.parse(job.created)) < 30_000) return { status: "running" };
    // Allow the detached child to initialise and publish its ownership.
    if (!owner && Date.now() - Date.parse(job.created) < 30_000) return { status: "running" };
    return { status: "error", error: "Discussion worker exited before saving its result. Retry the unfinished work." };
  }
  start(job: DiscussionJob) {
    const path = this.path(job.sessionId, job.id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readJobJson<DiscussionJob>(resolve(path, "job.json"));
      if (!existing) throw new Error("Discussion job was interrupted before submission. Retry with a new request ID.");
      if (existing.kind !== job.kind || existing.payload.requestFingerprint !== job.payload.requestFingerprint) {
        throw new Error("Discussion request ID already belongs to another request.");
      }
      return existing;
    }
    writeJobJson(resolve(path, "job.json"), job);
    const log = openSync(resolve(path, "worker.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)), this.worker, path], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), detached: true,
        stdio: ["ignore", log, log], env: process.env
      });
      child.once("error", error => writeJobJson(resolve(path, "state.json"), { status: "error", error: error.message }));
      child.unref();
    } finally { closeSync(log); }
    return job;
  }
  async stop(job: DiscussionJob) {
    if (this.state(job).status !== "running") return;
    writeJobJson(resolve(this.path(job.sessionId, job.id), "stop.json"), {});
    const deadline = Date.now() + 30_000;
    while (this.state(job).status === "running") {
      if (Date.now() > deadline) throw new Error("Stop requested; the discussion worker is still stopping.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  skipActor(job: DiscussionJob, actorId: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(actorId)) throw new Error("Invalid actor ID.");
    writeJobJson(resolve(this.path(job.sessionId, job.id), `skip-${actorId}.json`), { actorId });
  }
  skippedActors(job: DiscussionJob): string[] {
    return readdirSync(this.path(job.sessionId, job.id)).flatMap(name => {
      const match = /^skip-([a-zA-Z0-9_-]{1,80})\.json$/.exec(name);
      return match ? [match[1]] : [];
    });
  }
}
