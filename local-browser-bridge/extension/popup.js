const $ = (selector) => document.querySelector(selector);
const statusLabel = $("#status");
const current = await send({ type: "settings" });
$("#daemonUrl").value = current.daemonUrl;
statusLabel.textContent = current.connected ? "Connected to the local daemon." : "Waiting for the local daemon. Run browser-bridge pair if this extension was previously paired elsewhere.";
await render();
await renderPageValues();
$("#save").onclick = async () => { try {
    await send({ type: "saveSettings", daemonUrl: $("#daemonUrl").value });
    statusLabel.textContent = "Saved. The extension is connecting to the local daemon.";
}
catch (error) {
    statusLabel.textContent = String(error);
} };
$("#revoke").onclick = async () => { await send({ type: "revokeWebsiteGrant", origin: "*" }); await render(); };
$("#savePageValues").onclick = async () => {
    try {
        const parsed = JSON.parse($("#pageValues").value);
        const mappings = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "mappings" in parsed ? parsed.mappings : undefined;
        if (!Array.isArray(mappings))
            throw new Error("Enter a JSON array of URL-prefix mappings.");
        const result = await send({ type: "setPageValueMappings", mappings });
        $("#pageValues").value = JSON.stringify(result.mappings, null, 2);
        statusLabel.textContent = "Page values saved to the local daemon.";
    }
    catch (error) {
        statusLabel.textContent = error instanceof Error ? error.message : String(error);
    }
};
async function render() { const grants = await send({ type: "websiteGrants" }); const list = $("#grants"); list.replaceChildren(); const entries = Object.entries(grants); if (!entries.length)
    list.append(Object.assign(document.createElement("li"), { textContent: "None" })); for (const [origin, grant] of entries)
    list.append(Object.assign(document.createElement("li"), { textContent: `${origin} — ${(grant.scopes || []).join(", ")}` })); }
async function renderPageValues() {
    try {
        const result = await send({ type: "pageValueMappings" });
        $("#pageValues").value = JSON.stringify(result.mappings, null, 2);
    }
    catch (error) {
        statusLabel.textContent = error instanceof Error ? `Page values unavailable: ${error.message}` : String(error);
    }
}
async function send(message) { const response = await chrome.runtime.sendMessage(message); if (!response?.ok)
    throw new Error(response?.error || "Extension request failed."); return response.result; }
export {};
