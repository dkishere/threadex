export {};

const $ = <T extends Element>(selector: string): T => document.querySelector(selector) as T;
const statusLabel = $<HTMLElement>("#status");
const current = await send<{ daemonUrl: string; connected: boolean }>({ type: "settings" });
$<HTMLInputElement>("#daemonUrl").value = current.daemonUrl;
statusLabel.textContent = current.connected ? "Connected to the local daemon." : "Waiting for the local daemon. Run browser-bridge pair if this extension was previously paired elsewhere.";
await render();
await renderPageValues();
$<HTMLButtonElement>("#save").onclick = async () => { try { await send({ type: "saveSettings", daemonUrl: $<HTMLInputElement>("#daemonUrl").value }); statusLabel.textContent = "Saved. The extension is connecting to the local daemon."; } catch (error) { statusLabel.textContent = String(error); } };
$<HTMLButtonElement>("#revoke").onclick = async () => { await send({ type: "revokeWebsiteGrant", origin: "*" }); await render(); };
$<HTMLButtonElement>("#savePageValues").onclick = async () => {
  try {
    const parsed: unknown = JSON.parse($<HTMLTextAreaElement>("#pageValues").value);
    const mappings = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "mappings" in parsed ? (parsed as { mappings: unknown }).mappings : undefined;
    if (!Array.isArray(mappings)) throw new Error("Enter a JSON array of URL-prefix mappings.");
    const result = await send<{ mappings: unknown[] }>({ type: "setPageValueMappings", mappings });
    $<HTMLTextAreaElement>("#pageValues").value = JSON.stringify(result.mappings, null, 2);
    statusLabel.textContent = "Page values saved to the local daemon.";
  } catch (error) { statusLabel.textContent = error instanceof Error ? error.message : String(error); }
};
async function render(): Promise<void> { const grants = await send<Record<string, { scopes?: string[] }>>({ type: "websiteGrants" }); const list = $<HTMLUListElement>("#grants"); list.replaceChildren(); const entries = Object.entries(grants); if (!entries.length) list.append(Object.assign(document.createElement("li"), { textContent: "None" })); for (const [origin, grant] of entries) list.append(Object.assign(document.createElement("li"), { textContent: `${origin} — ${(grant.scopes || []).join(", ")}` })); }
async function renderPageValues(): Promise<void> {
  try {
    const result = await send<{ mappings: unknown[] }>({ type: "pageValueMappings" });
    $<HTMLTextAreaElement>("#pageValues").value = JSON.stringify(result.mappings, null, 2);
  } catch (error) { statusLabel.textContent = error instanceof Error ? `Page values unavailable: ${error.message}` : String(error); }
}
async function send<T>(message: object): Promise<T> { const response = await chrome.runtime.sendMessage(message) as { ok?: boolean; result?: T; error?: string }; if (!response?.ok) throw new Error(response?.error || "Extension request failed."); return response.result as T; }
