import type { PromptOrigin } from "./promptOrigin";

/** A rejected pre-delivery lookup can fall back to a queued turn; an ambiguous
 * delivery failure must remain an error to avoid sending the prompt twice. */
export async function steerProcessWake(
  sessionId: string,
  message: string,
  dependencies: {
    runningTurnId: (sessionId: string) => Promise<string | null>;
    steer: (input: { sessionId: string; turnId: string; message: string }) => Promise<Response>;
  }
): Promise<boolean> {
  const turnId = await dependencies.runningTurnId(sessionId);
  if (!turnId) return false;
  const response = await dependencies.steer({ sessionId, turnId, message });
  if (response.ok) return true;
  const body = await response.text();
  let error: unknown;
  try { error = JSON.parse(body).error; } catch { /* Preserve the response below. */ }
  if ((response.status === 404 && error === "Runner turn not found.")
    || (response.status === 409 && error === "Agent is not running.")) return false;
  throw new Error(`Process wake steer returned HTTP ${response.status}: ${body.slice(-500)}`);
}

export async function deliverProcessWake(
  input: {
    sessionId: string;
    turnId: string;
    message: string;
    workspaceId: string;
    approvalPolicy?: string;
    loadBalanceInWorkspace: boolean;
    promptOrigin?: PromptOrigin;
  },
  dependencies: {
    runningTurnId: (sessionId: string) => Promise<string | null>;
    steer: (input: { sessionId: string; turnId: string; message: string }) => Promise<Response>;
    start: (input: {
      sessionId: string;
      turnId: string;
      message: string;
      workspaceId: string;
      approvalPolicy?: string;
      loadBalanceInWorkspace: boolean;
      promptOrigin?: PromptOrigin;
    }) => Promise<Response>;
  }
): Promise<"steered" | "started"> {
  if (await steerProcessWake(input.sessionId, input.message, dependencies)) return "steered";
  const response = await dependencies.start(input);
  if (response.ok) {
    // The start response streams the woken turn until it ends. Callers may hold the
    // shared runner update queue, which that turn's own callbacks need, so drain the
    // stream in the background instead of waiting for the turn.
    void response.body?.pipeTo(new WritableStream()).catch(() => undefined);
    return "started";
  }
  const body = await response.text();
  throw new Error(`Process wake start returned HTTP ${response.status}: ${body.slice(-500)}`);
}
