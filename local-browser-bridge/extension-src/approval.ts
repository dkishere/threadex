export {};

const requestId = new URLSearchParams(location.search).get("requestId");
const response = await chrome.runtime.sendMessage({ type: "authorizationRequest", requestId }) as { result?: { origin: string; scopes: string[] } };
const request = response?.result;
if (!request) document.body.textContent = "This request has expired.";
else { document.querySelector("#origin")!.textContent = request.origin; const labels: Record<string, string> = { "tabs.read": "Read tabs for this website", "page.read": "Read page content", "page.interact": "Click, type, and navigate" }; for (const scope of request.scopes) { const item = document.createElement("li"); item.textContent = labels[scope] || scope; document.querySelector("#scopes")!.append(item); } document.querySelector("#allow")!.addEventListener("click", () => void decide(true)); document.querySelector("#deny")!.addEventListener("click", () => void decide(false)); }
async function decide(allow: boolean): Promise<void> { await chrome.runtime.sendMessage({ type: "authorization", requestId, allow, duration: (document.querySelector("#duration") as HTMLSelectElement).value }); window.close(); }
