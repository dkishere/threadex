export type NavigationTarget = {
  groupChat?: boolean;
  /** Group chat key (a project ID or "unassigned") kept in the hash next to `view=workspace-chat`.
   * Absent: an older link, read as the Unassigned chat. Undefined when writing keeps the current one. */
  chat?: string | null;
  view?: "workspace-chat" | "actor" | null;
  /** Only meaningful with `view: "actor"`; an actor view without an actor is not a target. */
  actorId?: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  turnId?: string | null;
  turnNumbers?: string | null;
  threadId?: string | null;
};

const WORKSPACE_QUERY_KEY = "workspaceId";
const SESSION_QUERY_KEY = "sessionId";
const ACTOR_QUERY_KEY = "actorId";
const CHAT_HASH_KEY = "chat";

export function readNavigationTarget(href = window.location.href): NavigationTarget {
  const url = new URL(href, window.location.origin);
  const view = url.searchParams.get("view");
  const hash = new URLSearchParams(url.hash.slice(1));
  const groupChat = hash.get("view") === "workspace-chat" || view === "workspace-chat";
  const actorId = view === "actor" ? nonEmptyQueryValue(url.searchParams.get(ACTOR_QUERY_KEY)) : null;
  const chat = groupChat ? nonEmptyQueryValue(hash.get(CHAT_HASH_KEY)) : null;
  return {
    workspaceId: nonEmptyQueryValue(url.searchParams.get(WORKSPACE_QUERY_KEY)),
    sessionId: nonEmptyQueryValue(url.searchParams.get(SESSION_QUERY_KEY)),
    ...(groupChat ? { groupChat: true } : {}),
    ...(chat ? { chat } : {}),
    ...(groupChat && !url.searchParams.get(SESSION_QUERY_KEY) ? { view: "workspace-chat" as const } : actorId ? { view: "actor" as const, actorId } : {}),
    ...(url.searchParams.get("turnId") ? { turnId: nonEmptyQueryValue(url.searchParams.get("turnId")) } : {}),
    ...(url.searchParams.get("turnNumbers") ? { turnNumbers: nonEmptyQueryValue(url.searchParams.get("turnNumbers")) } : {}),
    ...(url.searchParams.get("threadId") ? { threadId: nonEmptyQueryValue(url.searchParams.get("threadId")) } : {})
  };
}

export function readOptionalNavigationTarget(href = window.location.href) {
  return hasNavigationTarget(href) ? readNavigationTarget(href) : undefined;
}

export function hasNavigationTarget(href = window.location.href) {
  const url = new URL(href, window.location.origin);
  return url.searchParams.has(WORKSPACE_QUERY_KEY) || url.searchParams.has(SESSION_QUERY_KEY) || url.searchParams.has("threadId")
    || new URLSearchParams(url.hash.slice(1)).get("view") === "workspace-chat"
    || (url.searchParams.get("view") === "actor" && Boolean(nonEmptyQueryValue(url.searchParams.get(ACTOR_QUERY_KEY))));
}

export function navigationUrl(target: NavigationTarget, href = window.location.href) {
  const url = new URL(href, window.location.origin);
  const actorId = target.view === "actor" ? nonEmptyQueryValue(target.actorId ?? null) : null;
  setQueryValue(url, WORKSPACE_QUERY_KEY, target.workspaceId);
  setQueryValue(url, SESSION_QUERY_KEY, target.sessionId);
  setQueryValue(url, "view", target.view === "actor" && actorId ? "actor" : null);
  const hash = new URLSearchParams(url.hash.slice(1));
  const groupChat = target.groupChat ?? (target.view === "workspace-chat");
  if (groupChat) {
    hash.set("view", "workspace-chat");
    const chat = target.chat === undefined ? nonEmptyQueryValue(hash.get(CHAT_HASH_KEY)) : nonEmptyQueryValue(target.chat);
    if (chat) hash.set(CHAT_HASH_KEY, chat); else hash.delete(CHAT_HASH_KEY);
  } else if (hash.get("view") === "workspace-chat") { hash.delete("view"); hash.delete(CHAT_HASH_KEY); }
  // Preserve unrelated anchors (including annotation links) verbatim.
  if (groupChat || new URLSearchParams(url.hash.slice(1)).get("view") === "workspace-chat") url.hash = hash.toString();
  setQueryValue(url, ACTOR_QUERY_KEY, actorId);
  setQueryValue(url, "turnId", target.turnId ?? null);
  setQueryValue(url, "turnNumbers", target.turnNumbers ?? null);
  setQueryValue(url, "threadId", target.threadId ?? null);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function workspaceManagerSessionUrl(manager: { workspaceId: string; sessionId: string }, view: "raw" | "manager", href: string) {
  return navigationUrl({ workspaceId: manager.workspaceId, sessionId: manager.sessionId,
    view: view === "manager" ? "workspace-chat" : null }, href);
}

function setQueryValue(url: URL, key: string, value: string | null) {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
}

function nonEmptyQueryValue(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

/** History traversal can emit both events for one destination. */
export function listenToNavigation(navigate: () => void) {
  let popHref: string | null = null;
  const pop = () => { popHref = window.location.href; navigate(); };
  const hash = () => {
    if (popHref !== window.location.href) navigate();
    popHref = null;
  };
  window.addEventListener("popstate", pop);
  window.addEventListener("hashchange", hash);
  return () => {
    window.removeEventListener("popstate", pop);
    window.removeEventListener("hashchange", hash);
  };
}
