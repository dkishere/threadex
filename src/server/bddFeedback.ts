// Optional feedback UI for the maintained web-bdd v1 review shell. The preview
// injects it before bdd-app; the artifact on disk and external skill stay intact.
const feedbackScript = String.raw`(() => {
  "use strict";
  const core = globalThis.BDDCore;
  const list = document.getElementById("comments-list");
  const sidebar = document.querySelector("aside.review");
  if (!core || !list || !sidebar || globalThis.threadexBddFeedback) return;
  globalThis.threadexBddFeedback = true;
  const channel = "threadex-acp-v1", host = window.parent !== window ? window.parent : null;
  let data, session = null, connecting = false, sequence = 0;
  const pending = new Map(), deliveries = new Map();
  let section = document.getElementById("threadex-agent-feedback");
  if (!section) {
    section = document.createElement("section");
    section.id = "threadex-agent-feedback"; section.className = "share-tools";
    section.setAttribute("aria-label", "Agent feedback");
    const heading = document.createElement("strong"); heading.textContent = "Agent feedback";
    const status = document.createElement("p"); status.id = "agent-status";
    status.className = "muted"; status.setAttribute("role", "status");
    section.append(heading, status); sidebar.append(section);
  }
  const status = text => { document.getElementById("agent-status").textContent = text; };
  status("Enable agent feedback in the Threadex preview header to connect.");

  // Capture only successfully validated contracts, including imported or cached
  // comments. Return the original value unchanged to preserve the framework.
  for (const name of ["validate", "merge"]) {
    const original = core[name];
    core[name] = (...args) => {
      const result = original(...args);
      data = core.clone(result);
      return result;
    };
  }
  function request(method, params) {
    if (!host) return Promise.reject(new Error("Open this demo in Threadex's feedback preview."));
    const id = "bdd-" + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = method === "session/prompt" ? null : setTimeout(() => {
        pending.delete(id); reject(new Error("Agent connection timed out."));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      host.postMessage({ channel, message: { jsonrpc: "2.0", id, method, params } }, "*");
    });
  }
  function feedbackPrompt(commentId) {
    const comment = data.comments.find(item => item.id === commentId);
    if (!comment) throw new Error("Select a saved comment before sending feedback.");
    const ancestors = new Set();
    const collect = item => {
      for (const id of item.supersedes) {
        if (ancestors.has(id)) continue;
        ancestors.add(id); collect(data.comments.find(entry => entry.id === id));
      }
    };
    collect(comment);
    return "User feedback on a reviewed BDD demo. Preserve the exact comment text, target, revision and replacement history. " +
      "Decisions describe requested behavior; questions need answers. Inspect the current implementation before applying changes. " +
      "Competing replacements remain unresolved until explicitly reconciled.\n\n" + JSON.stringify({
        document: data.document, scenario: data.scenarios.find(item => item.id === comment.scenarioId),
        anchor: data.anchors.find(item => item.id === comment.anchorId), comment,
        history: data.comments.filter(item => ancestors.has(item.id)), conflictingCommentIds: [...core.conflicts(data)]
      }, null, 2);
  }
  function render() {
    if (!data) return;
    const comments = [...data.comments].reverse();
    const cards = [...list.children].filter(item => item.classList.contains("comment-card"));
    if (cards.length !== comments.length) return;
    const active = new Set(core.activeComments(data).map(item => item.id));
    cards.forEach((card, index) => {
      const comment = comments[index];
      let tools = card.querySelector("[data-acp-comment]");
      if (!active.has(comment.id)) { tools?.remove(); return; }
      if (!tools) {
        tools = document.createElement("div"); tools.dataset.acpComment = comment.id;
        const button = document.createElement("button"); button.type = "button"; button.className = "small";
        button.addEventListener("click", () => sendFeedback(comment.id));
        const info = document.createElement("p"); info.className = "comment-meta";
        tools.append(button, info); card.append(tools);
      }
      const delivery = deliveries.get(comment.id), button = tools.querySelector("button"), info = tools.querySelector("p");
      button.textContent = delivery?.state === "uncertain" ? "Retry agent feedback" : "Send to agent";
      button.disabled = !session || ["sending", "accepted", "completed", "cancelled"].includes(delivery?.state);
      info.textContent = delivery ? "Agent: " + delivery.state + (delivery.turnId ? " · " + delivery.turnId : "") : "";
    });
  }
  new MutationObserver(render).observe(list, { childList: true });
  async function sendFeedback(commentId) {
    if (!session) return;
    const previous = deliveries.get(commentId);
    const delivery = { state: "sending", requestId: data.document.id + ":" + commentId,
      prompt: previous?.prompt || feedbackPrompt(commentId) };
    deliveries.set(commentId, delivery); render(); status("Sending feedback…");
    try {
      if (delivery.prompt.length > 250000) throw new Error("Feedback context is too large. Export it for the agent instead.");
      const result = await request("session/prompt", { sessionId: session.id,
        prompt: [{ type: "text", text: delivery.prompt }], _meta: { "threadex/requestId": delivery.requestId } });
      delivery.state = result.stopReason === "cancelled" ? "cancelled" : "completed";
      status(delivery.state === "completed" ? "The agent finished processing feedback. Read its reply in Threadex." : "Feedback processing was cancelled.");
    } catch (error) { delivery.state = "uncertain"; status(error.message + " Your comment remains saved; retry uses the same request ID."); }
    render();
  }
  window.addEventListener("message", async event => {
    if (!host || event.source !== host || event.data?.channel !== channel) return;
    const envelope = event.data;
    if (envelope.disconnected) {
      session = null;
      for (const item of pending.values()) {
        clearTimeout(item.timer); item.reject(new Error("Agent disconnected. Check the saved turn before retrying."));
      }
      pending.clear(); status("Agent disconnected. Saved comments remain available for export."); render(); return;
    }
    const reply = envelope.message;
    if (reply?.jsonrpc === "2.0") {
      const item = pending.get(reply.id);
      if (item && ("result" in reply || "error" in reply)) {
        pending.delete(reply.id); clearTimeout(item.timer);
        if (reply.error) item.reject(new Error(reply.error.message)); else item.resolve(reply.result);
      }
      const receipt = reply.method === "session/update" && reply.params?.update?._meta?.["threadex/receipt"];
      if (receipt?.accepted) {
        for (const delivery of deliveries.values()) {
          if (delivery.state === "sending" && delivery.requestId === receipt.requestId) {
            delivery.state = "accepted"; delivery.turnId = receipt.turnId;
          }
        }
        status("Feedback received by the session. The agent will process it in turn."); render();
      }
    }
    if (envelope.session && !session && !connecting) {
      const target = envelope.session;
      if (typeof target.id !== "string" || typeof target.cwd !== "string") return;
      connecting = true;
      try {
        const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "web-bdd", version: "1" }, clientCapabilities: {} });
        if (initialized.protocolVersion !== 1 || !initialized.agentCapabilities?.sessionCapabilities?.resume) throw new Error("Agent does not support resuming a feedback session.");
        await request("session/resume", { sessionId: target.id, cwd: target.cwd, mcpServers: [] });
        session = target; status("Connected to " + target.id + ". Send a saved comment to queue feedback."); render();
      } catch (error) { status(error.message); }
      finally { connecting = false; }
    }
  });
  host?.postMessage({ channel, discover: true }, "*");
})();`;

export function addBddFeedback(html: string) {
  if (html.includes('id="threadex-bdd-feedback"') || !html.includes('id="bdd-data"') || !html.includes('id="bdd-core"')) return html;
  return html.replace(/<script\s+id="bdd-app"(?=\s|>)/, match =>
    `<script id="threadex-bdd-feedback">${feedbackScript}</script>\n${match}`);
}
