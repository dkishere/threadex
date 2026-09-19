import { createProjectViewer } from "./linkPreview";

type FileChange = { path: string; [key: string]: unknown };

export async function openProjectFiles({ sessionId, turnId, changes = [] }: { sessionId: string; turnId?: string; changes?: FileChange[] }) {
  const newTab = createProjectViewer();
  if (!newTab) {
    window.alert("Allow pop-ups to open Web VS Code.");
    return;
  }
  try {
    const response = changes.length > 0
      ? await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/web-vscode-review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId, changes, returnUrl: window.location.href })
        })
      : await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/web-vscode-url?returnUrl=${encodeURIComponent(window.location.href)}`);
    const payload = await response.json().catch(() => null);
    if (!response.ok || typeof payload?.url !== "string") throw new Error(payload?.error || `API returned ${response.status}`);
    newTab.navigate(payload.url);
  } catch (reason) {
    newTab.close();
    window.alert(reason instanceof Error ? reason.message : "Could not open Web VS Code.");
  }
}

export async function openSessionReview(sessionId: string) {
  const newTab = createProjectViewer();
  if (!newTab) {
    window.alert("Allow pop-ups to open Web VS Code.");
    return;
  }
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/web-vscode-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "session", returnUrl: window.location.href })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || typeof payload?.url !== "string") throw new Error(payload?.error || `API returned ${response.status}`);
    newTab.navigate(payload.url);
  } catch (reason) {
    newTab.close();
    window.alert(reason instanceof Error ? reason.message : "Could not open the session review.");
  }
}

export async function openCodeWalkthrough(sessionId: string) {
  const newTab = createProjectViewer();
  if (!newTab) {
    window.alert("Allow pop-ups to open Web VS Code.");
    return;
  }
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/web-vscode-walkthrough`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnUrl: window.location.href })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || typeof payload?.url !== "string") throw new Error(payload?.error || `API returned ${response.status}`);
    newTab.navigate(payload.url);
  } catch (reason) {
    newTab.close();
    window.alert(reason instanceof Error ? reason.message : "Could not open Code Walkthrough.");
  }
}
