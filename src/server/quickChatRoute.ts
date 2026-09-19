import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Router } from "express";
import type { QuickChatSession } from "../quickChat";
import { DesktopQuickChatBridge, type QuickChatBridge } from "./quickChatBridge";

type SavedSession = QuickChatSession & { conversationId?: string; parentMessageId?: string; interrupted?: boolean };
export class QuickChatService {
  private sessions: SavedSession[];
  private busy = false;
  constructor(private path: string, private bridge: QuickChatBridge) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(saved) || saved.some(s => typeof s.id !== "string" || typeof s.accountId !== "string" || !Array.isArray(s.messages))) throw new Error("Invalid Quick Chat session file");
      this.sessions = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.sessions = [];
    }
  }
  status() { return this.bridge.status(); }
  list(accountId: string) { return this.sessions.filter(s => s.accountId === accountId).map(s => this.publicSession(s)); }
  private publicSession(session: SavedSession): QuickChatSession {
    return {id: session.id, accountId: session.accountId, title: session.title, messages: session.messages, interrupted: session.interrupted};
  }
  private save() {
    mkdirSync(dirname(this.path), {recursive: true});
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.sessions), {mode: 0o600});
    renameSync(temporary, this.path);
  }
  async send(body: unknown) {
    const {accountId, sessionId, model, prompt} = (body ?? {}) as Record<string, unknown>;
    if (typeof accountId !== "string" || !accountId || typeof model !== "string" || !model || typeof prompt !== "string" || !prompt.trim() || prompt.length > 32000 || (sessionId != null && typeof sessionId !== "string")) throw new Error("Invalid Quick Chat message.");
    if (this.busy) throw new Error("A Quick Chat message is already being sent.");
    const existing = sessionId ? this.sessions.find(s => s.id === sessionId) : undefined;
    if (sessionId && (!existing || existing.accountId !== accountId)) throw new Error("Session does not belong to the selected account.");
    if (existing?.interrupted) throw new Error("This session has an interrupted request. Start a new chat to avoid sending with uncertain history.");
    this.busy = true;
    try {
      const status = await this.bridge.status();
      if (!status.accounts.some(a => a.id === accountId)) throw new Error("Selected ChatGPT App account is not connected. Refresh Quick Chat.");
      if (!status.models.some(m => m.id === model)) throw new Error("Selected ChatGPT model preset is unavailable. Refresh Quick Chat.");
      const session: SavedSession = existing ?? {id: randomUUID(), accountId, title: prompt.trim().slice(0, 70), messages: []};
      if (!existing) this.sessions.unshift(session);
      // Persist uncertainty before dispatch so a restart cannot silently resend a turn.
      session.interrupted = true;
      session.messages.push({id: randomUUID(), role:"user", text: prompt.trim()});
      this.save();
      const reply = await this.bridge.send({accountId, model, prompt: prompt.trim(), conversationId:session.conversationId, parentMessageId:session.parentMessageId});
      session.conversationId = reply.conversationId;
      session.parentMessageId = reply.messageId;
      session.messages.push({id: reply.messageId, role:"assistant", text:reply.text});
      session.interrupted = false;
      this.save();
      return this.publicSession(session);
    } finally { this.busy = false; }
  }
}

export function createQuickChatRouter(path: string, bridge: QuickChatBridge = new DesktopQuickChatBridge()) {
  const service = new QuickChatService(path, bridge);
  const router = Router();
  router.get("/status", async (_request, response) => {
    try { response.json(await service.status()); }
    catch (error) { response.json({accounts:[], models:[], error:error instanceof Error ? error.message : "Quick Chat unavailable"}); }
  });
  router.get("/sessions", (request, response) => {
    if (typeof request.query.accountId !== "string") { response.status(400).json({error:"Account is required."}); return; }
    response.json({sessions: service.list(request.query.accountId)});
  });
  router.post("/messages", async (request, response) => {
    try { response.json({session:await service.send(request.body)}); }
    catch (error) { response.status(409).json({error:error instanceof Error ? error.message : "Quick Chat failed"}); }
  });
  return router;
}
