import type { RequestHandler } from "express";
import { isClaudeModel } from "../modelCatalog";
import { buildTurnGrillMidTurnInputs, buildTurnGrillPrompt, buildTurnGrillSessionContext, grillTurn, isLongTurnGrill, turnGrillEffort, turnGrillModel } from "./turnGrill";
import type { HelperModels } from "./helperModelSettings";
import { detectConversationLanguage } from "./conversationLanguage";
import { normalizeModelTokenUsage, type ModelTokenUsage } from "./modelTokenUsage";
import { summarizeSessionFileChanges, type SessionStore } from "./sessionStore";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { RoundtableRunLog } from "./roundtableRunLog";
import { acknowledgeGrill, grillContentVersion, canFollowUpGrill, parseGrillIssues, type TurnGrill } from "../turnGrill";

type GrillUsage = {
  id: string; task: string; source: string; workspaceId: string;
  sessionId: string; accountId: string | null; model: string; usage: ModelTokenUsage | null;
};

const ACTIVITY_CHECKPOINT_MS = 2000;

// The server passes data/grill-logs; embedded handlers and tests keep journals in tmp.
export function grillLogDir(logDir?: string) {
  return resolve(logDir ?? resolve(tmpdir(), "threadex-grill-logs"));
}

/** Serves the latest griller run's activity journal, as round table attempts do. */
export function createTurnGrillActivityLogHandler({ sessionStore, logDir }: { sessionStore: SessionStore; logDir?: string }): RequestHandler<{ sessionId: string; turnId: string; attemptId: string }> {
  return async (req, res) => {
    try {
      const { sessionId, turnId, attemptId } = req.params;
      const activity = /^[a-f0-9-]{36}$/.test(attemptId) ? (await sessionStore.getTurnGrill(sessionId, turnId))?.activity : undefined;
      if (!activity || activity.id !== attemptId || activity.logPath !== resolve(grillLogDir(logDir), `${attemptId}.jsonl`)) {
        res.status(404).json({ error: "Activity log not found for this review." }); return;
      }
      res.type("text/plain").sendFile(activity.logPath, (error) => {
        if (error && !res.headersSent) res.status(404).json({ error: "Activity log is unavailable." });
      });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  };
}

export function createTurnGrillHandler({ sessionStore, serverUrl, recordUsage, runGrill = grillTurn, helperModels, logDir }: {
  sessionStore: SessionStore;
  serverUrl: string;
  recordUsage: (usage: GrillUsage) => Promise<void>;
  runGrill?: typeof grillTurn;
  helperModels?: () => HelperModels;
  logDir?: string;
}): RequestHandler<{ sessionId: string; turnId: string }> {
  const activeTurnGrills = new Set<string>();
  return async (req, res) => {
    const { sessionId, turnId } = req.params;
    const key = `${sessionId}:${turnId}`;
    const ownsLock = req.method !== "GET" && req.body?.action !== "ack";
    if (ownsLock && activeTurnGrills.has(key)) {
      res.status(409).json({ error: "This turn is already being checked." });
      return;
    }
    if (ownsLock) activeTurnGrills.add(key);
    let running: TurnGrill | null = null;
    let runLog: RoundtableRunLog | null = null;
    let checkpoints = Promise.resolve();
    try {
      const [session, turn] = await Promise.all([
        sessionStore.getSession(sessionId), sessionStore.getSessionTurn(turnId)
      ]);
      if (!session || !turn || turn.sessionId !== session.id) {
        res.status(404).json({ error: "Turn not found in this session." });
        return;
      }
      const saved = await sessionStore.getTurnGrill(sessionId, turnId);
      if (req.method === "GET") {
        // A lost process cannot leave a review permanently locked.
        if (saved?.status === "running" && !activeTurnGrills.has(key)) {
          const activity = saved.activity?.status === "running"
            ? { ...saved.activity, status: "interrupted" as const, finishedAt: new Date().toISOString(), error: "Griller worker was lost." }
            : saved.activity;
          const recovered: TurnGrill = { ...saved, revision: saved.revision + 1, status: "error", error: "Review interrupted. Retry to continue from the saved discussion.",
            ...(activity ? { activity } : {}) };
          await sessionStore.saveTurnGrill(sessionId, turnId, saved.revision, recovered);
          res.json({ grill: await sessionStore.getTurnGrill(sessionId, turnId) });
        } else res.json({ grill: saved });
        return;
      }
      const action = req.body?.action ?? "start";
      if (action === "ack") {
        try { res.json({ grill: await sessionStore.acknowledgeTurnGrill(sessionId, turnId, req.body.observedVersion) }); }
        catch (error) { res.status(400).json({ error: String(error) }); }
        return;
      }
      if (!["start", "save", "respond", "followup"].includes(action)) {
        res.status(400).json({ error: "Invalid Grill action." }); return;
      }
      if ((req.body?.revision ?? 0) !== (saved?.revision ?? 0) || saved?.status === "running") {
        res.status(409).json({ error: "Grill changed or is running. Reload the review before retrying." }); return;
      }
      let issues;
      try { issues = req.body?.issues === undefined ? saved?.issues ?? [] : parseGrillIssues(req.body.issues); }
      catch (error) { res.status(400).json({ error: String(error) }); return; }
      const followup = req.body?.prompt ?? "";
      if (typeof followup !== "string" || followup.length > 8000 || (action !== "start" && !saved)) {
        res.status(400).json({ error: "Invalid review or follow-up (maximum 8000 characters)." }); return;
      }
      if (saved && (issues.length !== saved.issues.length || issues.some((issue) => !saved.issues.some((old) => old.id === issue.id)))) {
        res.status(400).json({ error: "Issue IDs must match the saved review." }); return;
      }
      if (req.body?.issueId !== undefined) {
        res.status(400).json({ error: "Grill actions apply to the whole turn. Submit selected questions together." }); return;
      }
      if (action === "followup" && !canFollowUpGrill(saved)) {
        res.status(409).json({ error: "Ask thread and wait for its response before requesting a griller follow-up." }); return;
      }
      issues = issues.map((issue) => {
        const old = saved?.issues.find((candidate) => candidate.id === issue.id);
        return old ? { ...issue, status: issue.md !== old.md ? "open" as const : issue.status, responseMd: old.responseMd } : issue;
      });
      const requestedIssues = issues.filter((issue) => !issue.dropped && (action !== "followup" || issue.status !== "resolved"));
      if (action === "respond" && !requestedIssues.some((issue) => issue.selected)) {
        res.status(400).json({ error: "Select at least one question." }); return;
      }
      if (action === "save") {
        const changed = JSON.stringify(issues) !== JSON.stringify(saved!.issues);
        const next: TurnGrill = { ...saved!, issues, revision: saved!.revision + 1, updated: new Date().toISOString(),
          rounds: changed ? [...saved!.rounds, { id: crypto.randomUUID(), created: new Date().toISOString(), action: "save", prompt: "", issues }] : saved!.rounds };
        if (!await sessionStore.saveTurnGrill(sessionId, turnId, saved!.revision, next)) {
          res.status(409).json({ error: "Grill changed. Reload before saving." }); return;
        }
        res.json({ grill: next }); return;
      }
      if (turn.status !== "done") {
        res.status(409).json({ error: "Wait for this turn to finish before checking it." });
        return;
      }
      const workspace = await sessionStore.getWorkspace(session.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: "Session workspace not found." });
        return;
      }
      const [turnLiveItems, sessionTurns, approvalItemsByTurn, steerMessagesByTurn] = await Promise.all([
        sessionStore.listSessionTurnLiveItems(session.id, turn.id),
        sessionStore.listSessionTurns(session.id),
        sessionStore.listSessionApprovalLiveItems(session.id),
        sessionStore.listSessionSteerMessages(session.id)
      ]);
      if (action === "start" && saved?.rounds.length) {
        res.status(409).json({ error: "This turn already has a Grill review. Follow up on its issues." }); return;
      }
      const longTurn = isLongTurnGrill(turn);
      const prompt = buildTurnGrillPrompt({
        userInput: turn.userInput,
        midTurnInputs: buildTurnGrillMidTurnInputs(approvalItemsByTurn[turn.id] ?? [], steerMessagesByTurn[turn.id] ?? []),
        agentResponse: turn.agentResponse,
        fileChanges: summarizeSessionFileChanges([turn], { [turn.id]: turnLiveItems }).files.map(({ path, kind, additions, deletions, movePath }) => ({ path, kind, additions, deletions, ...(movePath ? { movePath } : {}) })),
        sessionContext: buildTurnGrillSessionContext(session, turn.id, sessionTurns),
        action, issues: requestedIssues, reservedIssueIds: issues.map((issue) => issue.id), rounds: (saved?.rounds ?? []).map((round) => ({ ...round,
        issues: round.issues.filter((issue) => requestedIssues.some((current) => current.id === issue.id)) })), followup, longTurn,
        autoLoop: req.body?.autoLoop === true || saved?.automatic === true,
        // A short target prompt such as "go" says little about the user's language.
        responseLanguage: detectConversationLanguage([...sessionTurns.map((sessionTurn) => sessionTurn.userInput), followup])
      });
      let acknowledged = saved;
      if (saved && req.body.observedVersion !== undefined) {
        try { acknowledged = acknowledgeGrill(saved, req.body.observedVersion); }
        catch (error) { res.status(400).json({ error: String(error) }); return; }
      }
      const next: TurnGrill = { ...acknowledged, revision: (saved?.revision ?? 0) + 1, status: "running", updated: new Date().toISOString(), issues, rounds: saved?.rounds ?? [], error: null,
        automatic: saved?.automatic === true || req.body?.autoLoop === true, request: { action, prompt: followup } };
      if (!await sessionStore.saveTurnGrill(sessionId, turnId, saved?.revision ?? 0, next)) {
        res.status(409).json({ error: "Grill changed. Reload before retrying." }); return;
      }
      running = next;
      const model = turnGrillModel(longTurn, helperModels?.());
      const claudeConfigDir = isClaudeModel(model)
        ? (await sessionStore.resolveClaudeAccount({ workspaceId: session.workspaceId, sessionId: session.id }))?.configDir ?? null
        : null;
      // The griller has no deadline. Its journal and checkpointed event count
      // show that a long review is still alive.
      const log = runLog = new RoundtableRunLog(grillLogDir(logDir), { sessionId, turnId, model, effort: turnGrillEffort(longTurn) });
      const checkpoint = () => {
        const activity = { ...log.attempt };
        checkpoints = checkpoints.then(async () => {
          while (true) {
            const current = await sessionStore.getTurnGrill(sessionId, turnId);
            if (current?.status !== "running") return;
            if (await sessionStore.saveTurnGrill(sessionId, turnId, current.revision, { ...current, revision: current.revision + 1, activity })) return;
          }
        }).catch((error) => console.warn(`Grill activity checkpoint failed for ${turnId}: ${error instanceof Error ? error.message : String(error)}`));
      };
      checkpoint();
      let lastCheckpoint = Date.now();
      const result = await runGrill(workspace.codexHome, prompt, session, serverUrl, sessionTurns.length, turn.id, longTurn, { model, claudeConfigDir,
        onEvent: (provider, event) => {
          log.providerEvent(provider, event);
          if (Date.now() - lastCheckpoint < ACTIVITY_CHECKPOINT_MS) return;
          lastCheckpoint = Date.now();
          checkpoint();
        } });
      log.finish("done");
      await checkpoints;
      await recordUsage({
        id: `background:turn_grill:${crypto.randomUUID()}`,
        task: "session_question", source: "app_server", workspaceId: workspace.id,
        // Claude usage is not attributable to a Codex account.
        sessionId: session.id, accountId: isClaudeModel(model) ? null : session.accountId, model,
        usage: normalizeModelTokenUsage(result.usage)
      });
      const returned = parseGrillIssues(JSON.parse(result.responseText.trim()));
      if (action !== "start" && (requestedIssues.some((old) => !returned.some((issue) => issue.id === old.id))
        || returned.some((issue) => !requestedIssues.some((old) => old.id === issue.id)
          && (action !== "followup" || issues.some((old) => old.id === issue.id))))) {
        throw new Error("Griller changed issue IDs. Retry the saved questions.");
      }
      // Only the user controls dropped state. Keep dropped records out of inference,
      // but retain their position, response and history in the saved issue list.
      const merged = action === "start" ? returned.map((issue) => ({ ...issue, dropped: false })) : issues.map((old) => {
        const answer = returned.find((candidate) => candidate.id === old.id);
        return answer && requestedIssues.find((candidate) => candidate.id === old.id)?.selected
          ? { ...old, responseMd: answer.responseMd, status: action === "followup" ? answer.status : old.status } : old;
      });
      if (action === "followup") merged.push(...returned.filter((issue) => !issues.some((old) => old.id === issue.id))
        .map((issue) => ({ ...issue, status: "open" as const, selected: true, dropped: false })));
      parseGrillIssues(merged);
      let completed: TurnGrill = { ...next, revision: next.revision + 1, status: "ready", updated: new Date().toISOString(), issues: merged, activity: { ...log.attempt },
        rounds: [...next.rounds, { id: crypto.randomUUID(), created: new Date().toISOString(), action, prompt: followup,
          issues: merged.map((issue) => action === "followup" && issues.some((old) => old.id === issue.id)
            && !requestedIssues.some((old) => old.id === issue.id && old.selected) ? { ...issue, selected: false } : issue) }] };
      // ACK and linked work completion may advance metadata during inference.
      // Retry CAS against that metadata, without dropping either new update.
      while (true) {
        const current = (await sessionStore.getTurnGrill(sessionId, turnId))!;
        completed = { ...completed, revision: current.revision + 1, contentVersion: grillContentVersion(current) + 1,
          acknowledgedVersion: current.acknowledgedVersion, workTurns: current.workTurns,
          issues: completed.issues.map((issue) => {
            const todoId = current.issues.find((candidate) => candidate.id === issue.id)?.todoId;
            return todoId ? { ...issue, todoId } : issue;
          }) };
        if (await sessionStore.saveTurnGrill(sessionId, turnId, current.revision, completed)) break;
      }
      res.json({ grill: completed });
    } catch (error) {
      if (running) {
        if (runLog?.attempt.status === "running") runLog.finish("error", error instanceof Error ? error.message : String(error));
        await checkpoints;
        while (true) {
          const current = (await sessionStore.getTurnGrill(sessionId, turnId))!;
          if (await sessionStore.saveTurnGrill(sessionId, turnId, current.revision, {
            ...current, revision: current.revision + 1, status: "error", error: error instanceof Error ? error.message : String(error),
            ...(runLog ? { activity: { ...runLog.attempt } } : {})
          })) break;
        }
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (ownsLock) activeTurnGrills.delete(key);
    }
  };
}
