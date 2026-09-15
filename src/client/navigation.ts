export type NavigationTarget = {
  workspaceId: string | null;
  sessionId: string | null;
};

const WORKSPACE_QUERY_KEY = "workspaceId";
const SESSION_QUERY_KEY = "sessionId";

export function readNavigationTarget(href = window.location.href): NavigationTarget {
  const url = new URL(href, window.location.origin);
  return {
    workspaceId: nonEmptyQueryValue(url.searchParams.get(WORKSPACE_QUERY_KEY)),
    sessionId: nonEmptyQueryValue(url.searchParams.get(SESSION_QUERY_KEY))
  };
}

export function readOptionalNavigationTarget(href = window.location.href) {
  return hasNavigationTarget(href) ? readNavigationTarget(href) : undefined;
}

export function hasNavigationTarget(href = window.location.href) {
  const url = new URL(href, window.location.origin);
  return url.searchParams.has(WORKSPACE_QUERY_KEY) || url.searchParams.has(SESSION_QUERY_KEY);
}

export function navigationUrl(target: NavigationTarget, href = window.location.href) {
  const url = new URL(href, window.location.origin);
  setQueryValue(url, WORKSPACE_QUERY_KEY, target.workspaceId);
  setQueryValue(url, SESSION_QUERY_KEY, target.sessionId);
  return `${url.pathname}${url.search}${url.hash}`;
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
