import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router } from "express";
import type { CollaborationGroup, CollaborationMember, CollaborationMessage, CollaborationView } from "../collaboration";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";
import type { UploadedAttachment } from "./attachmentUploads";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "../modelCatalog";
import { changedFilePaths } from "./changedFilePaths";

// One source for discoverable guidance and automatic runner instructions. Fail
// visibly if the bundled skill is missing rather than start an uninformed worker.
const collaborationSkill = readFileSync(new URL("../../skills/threadex-concurrent/SKILL.md", import.meta.url), "utf8");

const stableId = (...parts: string[]) => `collab_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)}`;
const now = () => new Date().toISOString();
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
function required(value: unknown, name: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function memberOf(group: CollaborationGroup, localId: string) {
  const member = group.members.find(m => m.localId === localId);
  if (!member) throw new Error("Unknown Concurrent local ID.");
  return member;
}
function requester(group: CollaborationGroup, sessionId: string) {
  const member = group.members.find(m => m.sessionId === sessionId);
  if (!member) throw new Error("Session does not belong to this Concurrent group.");
  return member;
}
function enqueue(group: CollaborationGroup, message: CollaborationMessage) {
  const existing = group.messages.find(m => m.id === message.id);
  if (existing) {
    if (existing.text !== message.text || existing.to !== message.to || existing.from !== message.from || existing.wait !== message.wait)
      throw new Error("Request ID already has a different message.");
    return existing;
  }
  if (group.messages.length >= 4096) throw new Error("Concurrent message limit reached. Start another group.");
  if (message.depth > 12) throw new Error("Concurrent follow-up depth limit reached.");
  if (message.wait) {
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === message.from) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return group.messages.some(m => m.from === id && m.wait && !m.completed && m.state !== "cancelled" && visit(m.to));
    };
    if (visit(message.to)) throw new Error("This dependency would create a cycle.");
  }
  group.messages.push(message);
  return message;
}
function message(input: Pick<CollaborationMessage, "id" | "from" | "to" | "text" | "reason" | "kind"> & Partial<CollaborationMessage>): CollaborationMessage {
  return { wait: false, parentId: null, depth: 0, state: "pending", targetTurnId: null,
    completed: false, error: null, created: now(), ...input };
}
function terminal(turn: SessionTurnRecord) {
  return turn.status === "done" || (turn.status === "todo" && turn.pendingReason === "stopped");
}

/** The same recipient contract accompanies queued assignments and live steering. */
export function collaborationDeliveryText(group: CollaborationGroup, item: CollaborationMessage) {
  const target = memberOf(group, item.to);
  const label = item.kind === "task" ? "Canonical assigned request"
    : item.kind === "followup" ? "Current follow-up message" : "Teammate result or delivery notice";
  // Keep the saved envelope and result body prefix compatible with existing readers.
  return `[Threadex Concurrent ${group.id}; message ${item.id}; ${item.from} → ${item.to}]\n${item.reason}\n\n` + [
    ...(item.kind === "result" ? [item.text] : []),
    `[Recipient contract; kind ${item.kind}]`,
    `You are the recipient ${target.localId} (display ID ${target.localId.toUpperCase()}) in Threadex session ${target.sessionId}. Main session: ${group.mainSessionId}.`,
    item.kind === "result"
      ? "This is a result or notice for you to assess in your own task context, not a new assignment to repeat the reported work. Resume any work unblocked by it; delivery or a finished turn alone does not prove task completion."
      : "This message is delivered to YOU to act on in this session. You are the owner named by the recipient ID, not an observer of another thread's delivery flow. Handle requested work within its scope and your assigned role; a delivery acknowledgement is not completion. Follow-ups may correct or inform your task rather than request new work.",
    "[End recipient contract]",
    ...(item.kind === "result" ? [] : [`[${label}]`, item.text, `[End ${label}]`])
  ].join("\n\n");
}

/** All dispatch intentions and receipts survive API/runner restarts. Network calls never hold DB locks. */
export class CollaborationService {
  private owner = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pulsing = false;
  private stopped = false;
  constructor(private store: SessionStore, private serverUrl: string,
    private saveAttachments: (id: string, attachments: UploadedAttachment[]) => NonNullable<CollaborationMessage["attachments"]>) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pulse().catch(error => console.warn("Collaboration recovery:", detail(error))), 3000);
    this.timer.unref();
    void this.pulse().catch(error => console.warn("Collaboration recovery:", detail(error)));
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async post(path: string, body: unknown) {
    const response = await fetch(`${this.serverUrl.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000)
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
    return payload;
  }

  async view(sessionId: string): Promise<CollaborationView | null> {
    const group = (await this.store.listCollaborationGroups(sessionId))[0];
    if (!group) return null;
    const activity: CollaborationView["activity"] = {};
    const paths = new Map<string, Set<string>>();
    await Promise.all(group.members.map(async member => {
      const turns = await this.store.listSessionTurns(member.sessionId);
      const running = turns.find(t => t.status === "running");
      const pending = turns.find(t => t.status === "todo" && t.pendingReason !== "stopped");
      const latest = running ?? pending ?? turns.at(-1);
      const waiting = group.messages.some(m => m.from === member.localId && m.wait && !m.completed && m.state !== "cancelled");
      const live = running ? await this.store.listSessionTurnLiveItems(member.sessionId, running.id) : [];
      for (const path of live.flatMap(changedFilePaths)) {
        const owners = paths.get(path) ?? new Set<string>(); owners.add(member.localId); paths.set(path, owners);
      }
      const recent = [...live].reverse().find(item => item && typeof item === "object" &&
        typeof (item as Record<string, unknown>).text === "string") as { text: string } | undefined;
      activity[member.localId] = { status: member.stopped ? "stopped" : running ? "running" : waiting ? "waiting" : pending ? "queued" : latest ? "idle" : "creating",
        turnId: latest?.id ?? null, progress: (recent?.text ?? latest?.agentResponse ?? "").slice(-1500) };
    }));
    return { ...group, activity, conflicts: [...paths].filter(([, owners]) => owners.size > 1).map(([path, owners]) => ({ path, members: [...owners] })) };
  }

  async create(mainSessionId: string) {
    const existing = (await this.store.listCollaborationGroups(mainSessionId))[0];
    if (existing) return existing;
    const main = await this.store.getSession(mainSessionId);
    if (!main) throw new Error("Main session not found.");
    const preferences = await this.store.getSessionModelPreferences(main.id);
    const initial: CollaborationGroup = { id: stableId("group", main.id), workspaceId: main.workspaceId,
      mainSessionId: main.id, revision: 0, created: now(), updated: now(), lease: null, messages: [], results: [],
      members: [{ localId: "main", sessionId: main.id, task: main.title, sourceSessionId: main.id,
        sourceTurnId: null, fork: null, model: preferences.selectedModel, effort: preferences.selectedEffort,
        approvalPolicy: await this.store.resolveApprovalPolicy(main.id), stopped: false, observed: {} }] };
    return this.store.changeCollaboration(initial.id, initial, group => group);
  }

  async fork(sessionId: string, body: Record<string, unknown>) {
    const requestId = required(body.requestId, "requestId");
    const task = required(body.task, "task", 100_000);
    const group = await this.create(sessionId);
    const caller = requester(group, sessionId);
    if (caller.localId !== "main") throw new Error("Only the main session can create collaboration members.");
    const sourceMember = memberOf(group, typeof body.source === "string" ? body.source : "main");
    if (sourceMember.localId !== "main") throw new Error("Ephemeral workers have no durable native fork source. Fork from main, which receives their conclusions and changes.");
    const source = await this.store.getSession(sourceMember.sessionId);
    if (!source?.threadId) throw new Error("The source session has no native thread to fork.");
    const sourceTurns = await this.store.listSessionTurns(source.id);
    const target = body.turnId ? sourceTurns.find(t => t.id === body.turnId) : sourceTurns.filter(t => t.status === "done").at(-1);
    if (!target || target.status !== "done") throw new Error("Choose a completed source turn.");
    const childSessionId = `tx_${stableId(group.id, requestId)}`;
    const requestFingerprint = stableId(JSON.stringify({ task, source: source.id, turnId: body.turnId ?? null,
      model: body.model ?? null, effort: body.modelReasoningEffort ?? null, fastMode: body.fastMode === true,
      approvalPolicy: body.approvalPolicy ?? null,
      attachments: body.attachments ?? [], skills: body.skills ?? [] }));
    const existing = group.members.find(m => m.sessionId === childSessionId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint)
        throw new Error("Fork request ID already belongs to another assignment.");
      await this.ensureMember(group, existing);
      return existing;
    }
    const nativeFork = await this.store.collaborationNativeTurn(source.id, target.id, source.threadId);
    if (!nativeFork) throw new Error("The selected turn has no verified native turn mapping. Wait for transcript synchronization or choose another completed turn.");
    const preferences = await this.store.getSessionModelPreferences(source.id);
    const model = typeof body.model === "string" ? required(body.model, "model") : preferences.selectedModel === "auto" ? DEFAULT_MODEL : preferences.selectedModel;
    if (!MODEL_OPTIONS.includes(model)) throw new Error("Unsupported Concurrent model.");
    const effort = typeof body.modelReasoningEffort === "string" ? body.modelReasoningEffort : preferences.selectedEffort;
    if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Invalid reasoning effort.");
    const approvalPolicy = typeof body.approvalPolicy === "string" ? body.approvalPolicy : await this.store.resolveApprovalPolicy(source.id);
    const attachments = Array.isArray(body.attachments) ? this.saveAttachments(stableId(childSessionId, requestFingerprint), body.attachments) : [];
    const skills = Array.isArray(body.skills) ? body.skills.map(skill => {
      if (!skill || typeof skill !== "object") throw new Error("Invalid skill.");
      return { name: required(skill.name, "skill name"), path: required(skill.path, "skill path", 4000) };
    }) : [];
    const member = await this.store.changeCollaboration(group.id, null, current => {
      const duplicate = current.members.find(m => m.sessionId === childSessionId);
      if (duplicate) {
        if (duplicate.requestFingerprint !== requestFingerprint) throw new Error("Fork request ID conflict.");
        return duplicate;
      }
      if (current.members.length >= 33) throw new Error("A Concurrent group supports up to 32 workers.");
      const member: CollaborationMember = { localId: `c${current.members.length}`, sessionId: childSessionId,
        requestFingerprint,
        task, sourceSessionId: source.id, sourceTurnId: target.id, fork: nativeFork,
        model, effort, fastMode: body.fastMode === true, approvalPolicy, stopped: false, observed: {} };
      current.members.push(member);
      enqueue(current, message({ id: stableId(childSessionId, "initial"), from: "main", to: member.localId,
        text: task, reason: "User requested Concurrent work", kind: "task", attachments, skills }));
      return member;
    });
    // Make the child visible to session navigation before the fork request
    // succeeds. Delivery still calls ensureMember to recover an interrupted
    // request between the group write and this materialization.
    await this.ensureMember(group, member);
    return member;
  }

  async send(sessionId: string, body: Record<string, unknown>) {
    const group = (await this.store.listCollaborationGroups(sessionId))[0];
    if (!group) throw new Error("Concurrent is not enabled for this session.");
    const from = requester(group, sessionId);
    const to = required(body.to, "to");
    const requestId = required(body.requestId, "requestId");
    const text = required(body.message, "message", 100_000);
    const reason = required(body.reason, "reason", 4000);
    const currentTurn = typeof body.turnId === "string" ? await this.store.getSessionTurn(body.turnId) : null;
    if (body.turnId && currentTurn?.sessionId !== sessionId) throw new Error("Source turn does not belong to the caller.");
    if (from.localId !== "main" && !currentTurn) throw new Error("Worker messages require their current turn ID.");
    return this.store.changeCollaboration(group.id, null, current => {
      const target = memberOf(current, to);
      if (to === from.localId) throw new Error("Cannot send a Concurrent message to yourself.");
      if (target.stopped || requester(current, sessionId).stopped) throw new Error("The Concurrent member is stopped.");
      const parent = current.messages.filter(m => m.to === from.localId && m.targetTurnId === currentTurn?.id)
        .sort((a, b) => b.depth - a.depth)[0];
      // Bound all agent-origin traffic, including siblings generated in one turn.
      const id = stableId(group.id, sessionId, requestId);
      if (!current.messages.some(m => m.id === id) && currentTurn &&
        current.messages.filter(m => m.from === from.localId && m.sourceTurnId === currentTurn.id).length >= 16)
        throw new Error("Per-turn Concurrent message limit reached.");
      return enqueue(current, message({ id, from: from.localId, to,
        text, reason: from.localId === "main" ? reason : `[${currentTurn!.id}] ${reason}`, kind: "followup", wait: body.wait === true,
        ...(currentTurn ? { sourceTurnId: currentTurn.id } : {}),
        parentId: parent?.id ?? null, depth: (parent?.depth ?? 0) + 1 }));
    });
  }

  async control(sessionId: string, body: Record<string, unknown>) {
    const group = (await this.store.listCollaborationGroups(sessionId))[0];
    if (!group || group.mainSessionId !== sessionId) throw new Error("Only the main session can control workers.");
    const localId = required(body.localId, "localId");
    if (localId === "main") throw new Error("Use the normal main-session stop control.");
    const target = await this.store.changeCollaboration(group.id, null, current => {
      const member = memberOf(current, localId);
      member.stopped = body.stopped !== false;
      if (member.stopped) {
        const waiting = current.messages.filter(m => m.to === localId && m.wait && !m.completed && m.state !== "cancelled");
        for (const m of current.messages) {
          if ((m.to === localId || m.from === localId) && m.state === "pending") m.state = "cancelled";
          if (m.to === localId || m.from === localId) m.completed = true;
        }
        for (const m of waiting) enqueue(current, message({ id: stableId(m.id, "dependency-stopped"), from: localId, to: m.from,
          kind: "result", reason: "Dependency stopped", text: `${localId} was stopped. Its work is not complete. Reassess your dependency using the saved session ${member.sessionId}.`, depth: m.depth }));
      }
      return member;
    });
    if (target.stopped) await this.stopMember(target);
    return target;
  }

  private async stopMember(target: CollaborationMember) {
    const turns = await this.store.listSessionTurns(target.sessionId);
    // Cancel queued turns before the running turn so its completion cannot drain the queue.
    for (const turn of [...turns.filter(t => t.status === "todo" && t.pendingReason !== "stopped"), ...turns.filter(t => t.status === "running")]) {
      await this.post("/api/runner/stop", { sessionId: target.sessionId, turnId: turn.id });
    }
  }

  async resolveDelivery(sessionId: string, body: Record<string, unknown>) {
    const group = (await this.store.listCollaborationGroups(sessionId))[0];
    if (!group || group.mainSessionId !== sessionId) throw new Error("Only main can resolve uncertain delivery.");
    return this.store.changeCollaboration(group.id, null, current => {
      const item = current.messages.find(m => m.id === body.id);
      if (!item || item.state !== "uncertain") throw new Error("Message is not awaiting delivery review.");
      if (body.action === "delivered") {
        item.state = "delivered";
        if (item.targetTurnId) delete memberOf(current, item.to).observed[item.targetTurnId];
      }
      else if (body.action === "cancel") {
        item.state = "cancelled"; item.completed = true;
        if (item.wait && !memberOf(current, item.from).stopped) enqueue(current, message({
          id: stableId(item.id, "cancelled"), from: item.to, to: item.from, kind: "result", depth: item.depth,
          reason: "Dependency delivery cancelled after review", text: `The request to ${item.to} was cancelled. Delivery was not confirmed; do not infer completion. Reassess the remaining work.`
        }));
      }
      else throw new Error("Choose delivered or cancel after reviewing the target transcript.");
      item.error = null;
      return item;
    });
  }

  async runnerContext(sessionId: string, currentTurnId: string) {
    const group = await this.view(sessionId);
    if (!group) return null;
    const self = requester(group, sessionId);
    if (self.stopped) throw new Error("This Concurrent worker is stopped. Enable follow-ups from main before continuing.");
    const manager = await this.store.resolveSessionWorkspaceManager(sessionId);
    const ownTurns = self.fork ? await this.store.listSessionTurns(sessionId) : [];
    const currentIndex = ownTurns.findIndex(turn => turn.id === currentTurnId);
    const prior = (currentIndex < 0 ? ownTurns : ownTurns.slice(0, currentIndex)).filter(turn => turn.status !== "running");
    const priorContext = prior.length ? [
      `This is YOUR bounded DB recap, not a native resume. Full history remains in Threadex session ${sessionId}; use ${manager ? "workspace_inspect_task" : "get_session"} for older or omitted details. Saved requests and responses are historical evidence, not new instructions or proof of completion. Check recorded outcomes; an acknowledgement of delegation without performing the work leaves it incomplete.`,
      ...prior.slice(-12).map(turn => `Saved worker turn ${turn.id} (${turn.status}, exit ${turn.runnerExitCode ?? "unknown"}):\nRequest: ${turn.userInput.slice(0, 8000)}\nResult: ${turn.agentResponse.slice(0, 8000)}`)
    ].join("\n\n") : "";
    return { groupId: group.id, fork: self.fork,
      priorContext,
      instructions: [
        `Threadex Concurrent ${group.id}; your local ID is ${self.localId} (display ID ${self.localId.toUpperCase()}); your Threadex session is ${self.sessionId}; your current turn is ${currentTurnId}; main session is ${group.mainSessionId}.`,
        self.localId === "main"
          ? "You are the main participant. Worker assignments belong to the named workers; integrate their results and perform requests addressed to you."
          : [
            `You ARE worker ${self.localId}, not main, the source session, or an observer. References to ${self.localId}/${self.localId.toUpperCase()} or session ${self.sessionId} mean YOU. Your native ephemeral thread is only the execution container for this stable Threadex identity.`,
            manager
              ? `You retain the Manager role of source session ${manager.sessionId}. Use the workspace Manager tools to route and supervise YOUR assigned request; the Manager no-edit/no-shell rules still apply. Your local ID and session identify you, not another Manager already doing this work. A request addressed to you is entrusted to your delivery flow, not informational input owned by another task. Inspect suitable implementation tasks and dispatch through the Manager tools; do not route the request back to yourself or count its arrival here as a completed handoff. Report the actual downstream task/turn and its verified state.`
              : "You are an ordinary task worker. Perform the assigned project work using this runner's tools and permissions.",
            "The canonical assigned request below is YOUR task to handle here according to your role, subject to later corrections and follow-ups addressed to you. Inherited source history supplies background, not the source agent's identity. Historical statements that this worker has received or is doing this work refer to you; they do not establish that someone else will do it.",
            `[Canonical assigned request]\n${self.task}\n[End canonical assigned request]`,
            "Continue incomplete assigned work using your saved outcomes and current message. Do not repeat verified completed work. Treat a result as evidence or a dependency update, not an automatic new assignment. Direct user requests in this worker session are yours to handle."
          ].join("\n\n"),
        "The complete threadex-concurrent SKILL.md is already included below as developer instructions. Treat it as read and applied for this turn. Do not open or cat its file; there is no additional content to fetch. This also applies to a fresh ephemeral fork and each follow-up.",
        collaborationSkill,
        "The roster entry marked isSelf is you. Its running/queued status describes your own execution, not another worker handling your assignment. Roster task previews and progress are metadata, not replacements for the canonical request or evidence of completion.",
        `Roster snapshot ${group.updated}: ${JSON.stringify(group.members.map(m => ({ localId: m.localId, sessionId: m.sessionId, isSelf: m.sessionId === sessionId, task: m.task.slice(0, 2000), ...group.activity[m.localId] })))}`,
        `Concurrent file overlaps (coordinate before further edits): ${JSON.stringify(group.conflicts)}`
      ].join("\n") };
  }

  private async ensureMember(group: CollaborationGroup, member: CollaborationMember) {
    if (await this.store.getSession(member.sessionId)) return;
    const source = await this.store.getSession(member.sourceSessionId);
    if (!source || source.workspaceId !== group.workspaceId) throw new Error("Collaboration source is unavailable.");
    await this.store.upsertSession({ id: member.sessionId, threadId: null, workspaceId: source.workspaceId,
      cwd: source.cwd, accountId: source.accountId, title: `${member.localId}: ${member.task.slice(0, 80)}`,
      titleSource: "user", description: member.task.slice(0, 2000), parentSessionId: group.mainSessionId,
      forkedFromTurnId: member.sourceTurnId }, { createOnly: true });
    const preferences = await this.store.getSessionModelPreferences(source.id);
    await this.store.setSessionModelPreferences(member.sessionId, { ...preferences, selectedModel: member.model,
      selectedEffort: member.effort as typeof preferences.selectedEffort,
      gearProfiles: preferences.gearProfiles.map((gear, i) => ({ ...gear, fastMode: member.fastMode === true,
        ...(i === preferences.activeGearIndex
          ? { model: member.model, effort: member.effort as typeof gear.effort } : {}) })) });
  }

  private async collect(group: CollaborationGroup) {
    for (const member of group.members) {
      if (member.localId === "main" && !group.messages.some(m => m.to === "main" && !m.completed && m.state === "delivered")) continue;
      const turns = await this.store.listSessionTurns(member.sessionId);
      for (const turn of turns.filter(terminal)) {
        if (member.localId === "main") {
          const received = group.messages.filter(m => m.to === "main" && m.targetTurnId === turn.id && m.state === "delivered" && !m.completed);
          if (!received.length) continue;
          if (!received.some(m => m.wait)) {
            await this.store.changeCollaboration(group.id, null, current => {
              for (const item of current.messages) {
                if (item.to === "main" && item.targetTurnId === turn.id && item.state === "delivered") item.completed = true;
              }
            });
            continue;
          }
        }
        const status = turn.pendingReason === "stopped" || turn.runnerExitCode === 143 || turn.runnerExitCode === 130
          ? "stopped" : turn.runnerExitCode && turn.runnerExitCode !== 0 || /^Codex error:/i.test(turn.agentResponse) ? "failed" : "completed";
        const fingerprint = stableId(turn.id, status, turn.agentResponse);
        if (member.observed[turn.id] === fingerprint) continue;
        // A turn ending to await another worker is a checkpoint, not a completed assignment.
        if (status === "completed" && group.messages.some(m => m.from === member.localId && m.sourceTurnId === turn.id && m.wait)) {
          await this.store.changeCollaboration(group.id, null, current => { memberOf(current, member.localId).observed[turn.id] = fingerprint; });
          continue;
        }
        const inspection = await this.store.inspectSession({ sessionId: member.sessionId, turnId: turn.id, view: "file_changes", maxTextChars: 0 });
        const changes = inspection?.fileChanges ?? [];
        await this.store.changeCollaboration(group.id, null, current => {
          const worker = memberOf(current, member.localId);
          if (worker.observed[turn.id] === fingerprint) return;
          worker.observed[turn.id] = fingerprint;
          const resultId = stableId(group.id, fingerprint);
          const summary = turn.agentResponse.slice(0, 16000) || `Worker ${status} without a final answer.`;
          if (!current.results.some(r => r.id === resultId)) current.results.push({ id: resultId, localId: member.localId, sessionId: member.sessionId,
            turnId: turn.id, status, summary, changes, created: now() });
          const text = `${member.localId} ${status}. Session: ${member.sessionId}; turn: ${turn.id}.\nConclusion:\n${summary}\n\nChange list (recorded edits):\n${changes.map(change => `${change.kind}: ${change.path}${change.movePath ? ` → ${change.movePath}` : ""} (+${change.additions}/-${change.deletions})`).join("\n") || "No file edits recorded; consult the conclusion for non-file work."}\n\nIntegrate this result using your existing context. The work reported above has already been performed; do not repeat it merely because this result arrived. Failed or stopped attempts are not successful completion.`;
          const recipients = new Set<string>(member.localId === "main" ? [] : ["main"]);
          const coveredTurns = new Set(turns.slice(0, turns.findIndex(t => t.id === turn.id) + 1).filter(terminal).map(t => t.id));
          const causes = current.messages.filter(m => m.to === member.localId && m.targetTurnId && coveredTurns.has(m.targetTurnId) && !m.completed);
          const depth = Math.max(0, ...causes.map(m => m.depth));
          for (const m of current.messages) {
            if (m.to === member.localId && m.targetTurnId && coveredTurns.has(m.targetTurnId) && m.state === "delivered" && !m.completed) {
              m.completed = true;
              if (m.wait) recipients.add(m.from);
            }
          }
          for (const to of recipients) {
            if (memberOf(current, to).stopped) continue;
            enqueue(current, message({ id: stableId(resultId, to), from: member.localId, to, text,
              reason: "Worker result; integrate without automatically generating further work", kind: "result",
              depth, parentId: causes[0]?.id ?? null }));
          }
        });
      }
    }
  }

  private async deliver(group: CollaborationGroup, item: CollaborationMessage) {
    const target = memberOf(group, item.to);
    if (target.stopped) return;
    await this.ensureMember(group, target);
    const text = collaborationDeliveryText(group, item);
    const running = await this.store.getLatestRunningTurn(target.sessionId);
    if (item.state === "steering" || (running && item.kind !== "task" && !item.forceQueue)) {
      const turnId = item.targetTurnId ?? running!.id;
      const active = await this.store.changeCollaboration(group.id, null, current => {
        const saved = current.messages.find(m => m.id === item.id)!;
        if (!["pending", "steering"].includes(saved.state) || memberOf(current, saved.to).stopped ||
          (saved.state === "steering" && saved.targetTurnId !== turnId)) return false;
        saved.state = "steering"; saved.targetTurnId = turnId;
        return true;
      });
      if (!active) return;
      const receipt = await this.post("/api/concurrent/steer", {
        groupId: group.id, messageId: item.id, sessionId: target.sessionId, turnId, message: text
      });
      if (receipt.delivery === "pending") return;
      if (receipt.delivery === "uncertain") {
        await this.store.changeCollaboration(group.id, null, current => {
          const saved = current.messages.find(m => m.id === item.id)!;
          saved.state = "uncertain"; saved.error = "Steer receipt is uncertain. Inspect the target before resolving; no automatic resend.";
          enqueue(current, message({ id: stableId(item.id, "review-notice"), from: item.to, to: "main", kind: "result", forceQueue: true,
            reason: "Delivery requires review; do not repeat the assignment",
            text: `Message ${item.id} from ${item.from} to ${item.to} has no confirmed steer receipt for turn ${turnId}. Inspect session ${target.sessionId} before acknowledging or cancelling it in the Concurrent panel. Do not resend or repeat the work automatically. The original message remains in the group DB.` }));
        });
        return;
      }
      if (receipt.delivery === "delivered") {
        await this.store.changeCollaboration(group.id, null, current => {
          const saved = current.messages.find(m => m.id === item.id)!;
          saved.state = "delivered"; saved.error = null;
          // A late receipt must still wake dependency waiters even if completion was already observed.
          delete memberOf(current, target.localId).observed[turnId];
        });
        return;
      }
      // Only an explicit not-sent receipt permits conversion to a queued turn.
      if (receipt.delivery !== "not_sent") throw new Error("Unknown collaboration delivery receipt.");
    }
    const queuedTurnId = stableId(item.id, "turn");
    const stillActive = await this.store.changeCollaboration(group.id, null, current => {
      const saved = current.messages.find(m => m.id === item.id)!;
      return ["pending", "steering"].includes(saved.state) && !memberOf(current, saved.to).stopped;
    });
    if (!stillActive) return;
    const preferences = await this.store.getSessionModelPreferences(target.sessionId);
    const approvalPolicy = await this.store.resolveApprovalPolicy(target.sessionId) ?? target.approvalPolicy;
    await this.post("/api/pending-turns", { sessionId: target.sessionId, turnId: queuedTurnId,
      workspaceId: group.workspaceId, message: text, model: preferences.selectedModel === "auto" ? DEFAULT_MODEL : preferences.selectedModel,
      modelReasoningEffort: preferences.selectedEffort,
      fastMode: preferences.gearProfiles[preferences.activeGearIndex]?.fastMode === true,
      approvalPolicy, attachments: item.attachments, skills: item.skills,
      autoModel: preferences.selectedModel === "auto", loadBalanceInWorkspace: false, backgroundTask: true });
    await this.store.changeCollaboration(group.id, null, current => {
      const saved = current.messages.find(m => m.id === item.id)!;
      saved.state = "delivered"; saved.targetTurnId = queuedTurnId; saved.error = null;
      delete memberOf(current, target.localId).observed[queuedTurnId];
    });
  }

  async pulse() {
    if (this.pulsing || this.stopped) return;
    this.pulsing = true;
    try {
      for (const group of await this.store.listCollaborationGroups()) {
        if (this.stopped) break;
        const acquired = await this.store.changeCollaboration(group.id, null, current => {
          if (current.lease && current.lease.owner !== this.owner && current.lease.until > Date.now()) return false;
          current.lease = { owner: this.owner, until: Date.now() + 120_000 }; return true;
        });
        if (!acquired) continue;
        try {
          for (const member of group.members.filter(m => m.stopped)) await this.stopMember(member);
          await this.collect(group);
          // One dispatch per group per pulse bounds lease duration and gives siblings fair progress.
          const fresh = (await this.store.listCollaborationGroups(group.mainSessionId))[0];
          const next = fresh?.messages.find(m => (m.state === "pending" || m.state === "steering") &&
            (m.nextAttemptAt ?? 0) <= Date.now() && !memberOf(fresh, m.to).stopped);
          if (next) {
            const renewed = await this.store.changeCollaboration(group.id, null, current => {
              if (current.lease?.owner !== this.owner) return false;
              current.lease.until = Date.now() + 120_000; return true;
            });
            if (!renewed) continue;
            try { await this.deliver(fresh, next); }
            catch (error) { await this.store.changeCollaboration(group.id, null, current => {
              const saved = current.messages.find(m => m.id === next.id)!; saved.error = detail(error);
              saved.attempts = (saved.attempts ?? 0) + 1;
              saved.nextAttemptAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(saved.attempts, 5));
            }); }
          }
          await this.store.changeCollaboration(group.id, null, current => { current.error = null; });
        } catch (error) {
          await this.store.changeCollaboration(group.id, null, current => { current.error = detail(error); });
        } finally {
          await this.store.changeCollaboration(group.id, null, current => {
            if (current.lease?.owner === this.owner) current.lease = null;
          });
        }
      }
    } finally { this.pulsing = false; }
  }
}

export function createCollaborationRouter(service: CollaborationService) {
  const router = Router();
  router.get("/:sessionId", async (req, res) => {
    try { res.json({ group: await service.view(req.params.sessionId) }); }
    catch (error) { res.status(400).json({ error: detail(error) }); }
  });
  for (const action of ["fork", "send", "control", "resolveDelivery"] as const) {
    router.post(`/:sessionId/${action}`, async (req, res) => {
      try { res.json(await service[action](req.params.sessionId, req.body ?? {})); }
      catch (error) { res.status(409).json({ error: detail(error) }); }
    });
  }
  return router;
}
