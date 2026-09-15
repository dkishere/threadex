import { useSyncExternalStore } from "react";
import { grillAwaitingAck, type GrillSummary, type TurnGrill } from "../turnGrill";

export type RingEvent = {
  pos: number;
  eventId: string;
  type: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
  timestamp: string;
};

export type SessionPageState = {
  sessions: unknown[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  projects: SessionProjectPageState[];
};

export type SessionProjectPageState = {
  cwd: string;
  offset: number;
  limit: number;
  hasMore: boolean;
  total: number;
  nextOffset: number | null;
};

export type WorkspaceStatusMonitor = {
  id: string;
  name: string;
  active_sessions: Array<{
    id: string;
    name: string;
    asking_approvals: Array<{
      approvalId: string;
      sessionId: string;
      turnId: string;
      requestId: number;
      method: string;
      params: unknown;
      createdAt: string;
    }>;
  }>;
};

export type ProcessMonitor = {
  id: string;
  workspaceId: string;
  label: string;
  command: string | null;
  executable: string | null;
  dockerImage: string | null;
  dockerRunArgs: string[];
  args: string[];
  logFile: string | null;
  entryPoints: string[];
  cwd: string;
  pid: number | null;
  status: "starting" | "running" | "exited" | "stopped" | "error";
  managed: boolean;
  readOnly?: boolean;
  restartable?: boolean;
  removeOnExit: boolean;
  wakePrompt: string | null;
  wakeSessionId: string | null;
  wakeThreadId: string | null;
  timeoutAt: string | null;
  wakeStatus: "none" | "pending" | "sent" | "done" | "error";
  wakeError: string | null;
  wokenAt: string | null;
  startedAt: string | null;
  lastExitCode: number | null;
  lastSignal: string | null;
  error: string | null;
  created: string;
  updated: string;
};

export type WaitEvent = {
  id: string;
  workspaceId: string;
  topic: string;
  subjectKey: string;
  status: "pending" | "fired" | "cancelled";
  expectedAt: string | null;
  payload: unknown;
  firedAt: string | null;
  created: string;
  updated: string;
};

export type WaitSubscription = {
  id: string;
  eventId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  actionType: "retry_turn" | "enqueue_prompt" | "notify";
  actionPayload: unknown;
  status: "waiting" | "dispatching" | "done" | "error" | "cancelled";
  attempts: number;
  error: string | null;
  deliveredAt: string | null;
  created: string;
  updated: string;
};

export type EventStoreState = {
  grillSummaries: GrillSummary[];
  workspaceSnapshot: unknown | null;
  sessionPage: SessionPageState;
  selectedSessionSnapshot: unknown | null;
  statusMonitor: WorkspaceStatusMonitor[];
  processMonitors: ProcessMonitor[];
  waitEvents: WaitEvent[];
  waitSubscriptions: WaitSubscription[];
  cursor: number;
};

type EventsResponse = {
  grillSummaries?: GrillSummary[];
  events?: RingEvent[];
  nextPos?: number;
  resetRequired?: boolean;
  statusMonitor?: WorkspaceStatusMonitor[];
  processMonitors?: ProcessMonitor[];
  waitEvents?: WaitEvent[];
  waitSubscriptions?: WaitSubscription[];
};

type EventListener = (event: RingEvent) => void;

const CURSOR_STORAGE_KEY = "threadex.event-cursor";
const emptySessionPage: SessionPageState = {
  sessions: [],
  offset: 0,
  limit: 20,
  hasMore: false,
  nextOffset: null,
  projects: []
};

export class EventStore {
  private state: EventStoreState = {
    grillSummaries: [],
    workspaceSnapshot: null,
    sessionPage: emptySessionPage,
    selectedSessionSnapshot: null,
    statusMonitor: [],
    processMonitors: [],
    waitEvents: [],
    waitSubscriptions: [],
    cursor: readStoredCursor()
  };
  private listeners = new Set<() => void>();
  private cursorListeners = new Set<() => void>();
  private eventListeners = new Map<string, Set<EventListener>>();
  private pollPromise: Promise<boolean> | null = null;

  getState = () => this.state;
  getCursor = () => this.state.cursor;

  reportGrill(sessionId: string, turnId: string, review: TurnGrill) {
    const previous = this.state.grillSummaries.find((item) => item.sessionId === sessionId && item.turnId === turnId);
    if (previous && previous.revision >= review.revision) return;
    this.state = { ...this.state, grillSummaries: [...this.state.grillSummaries.filter((item) => item !== previous),
      { sessionId, turnId, revision: review.revision, pending: grillAwaitingAck(review) }] };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeCursor = (listener: () => void) => {
    this.cursorListeners.add(listener);
    return () => {
      this.cursorListeners.delete(listener);
    };
  };

  subscribeTo(types: string[], listener: EventListener) {
    for (const type of types) {
      const listeners = this.eventListeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      this.eventListeners.set(type, listeners);
    }
    return () => {
      for (const type of types) {
        const listeners = this.eventListeners.get(type);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.eventListeners.delete(type);
      }
    };
  }

  setWorkspaceSnapshot(
    workspaceSnapshot: unknown,
    sessionPage: SessionPageState,
    selectedSessionSnapshot: unknown | null,
    cursor: number
  ) {
    const cursorChanged = normalizeCursor(cursor) !== this.state.cursor;
    this.state = {
      workspaceSnapshot,
      grillSummaries: readArrayField<GrillSummary>(workspaceSnapshot, "grillSummaries"),
      sessionPage,
      selectedSessionSnapshot,
      statusMonitor: readArrayField<WorkspaceStatusMonitor>(workspaceSnapshot, "statusMonitor"),
      processMonitors: readProcessMonitors(workspaceSnapshot),
      waitEvents: readArrayField<WaitEvent>(workspaceSnapshot, "waitEvents"),
      waitSubscriptions: readArrayField<WaitSubscription>(workspaceSnapshot, "waitSubscriptions"),
      cursor: normalizeCursor(cursor)
    };
    persistCursor(this.state.cursor);
    this.emitChange();
    if (cursorChanged) this.emitCursorChange();
  }

  setSessionPage(sessionPage: SessionPageState, append = false) {
    const sessions = append
      ? mergeRecordsById(this.state.sessionPage.sessions, sessionPage.sessions)
      : sessionPage.sessions;
    const nextSessionPage = { ...sessionPage, sessions };
    if (jsonValuesEqual(this.state.sessionPage, nextSessionPage)) return;
    this.state = { ...this.state, sessionPage: nextSessionPage };
    this.emitChange();
  }

  setSessionProjectPage(cwd: string, projectPage: SessionProjectPageState, sessions: unknown[]) {
    const projects = this.state.sessionPage.projects.some((project) => project.cwd === cwd)
      ? this.state.sessionPage.projects.map((project) => project.cwd === cwd ? projectPage : project)
      : [...this.state.sessionPage.projects, projectPage];
    const nextSessionPage = {
      ...this.state.sessionPage,
      sessions: mergeRecordsById(this.state.sessionPage.sessions, sessions),
      hasMore: projects.some((project) => project.hasMore),
      projects
    };
    if (jsonValuesEqual(this.state.sessionPage, nextSessionPage)) return;
    this.state = {
      ...this.state,
      sessionPage: nextSessionPage
    };
    this.emitChange();
  }

  setSelectedSessionSnapshot(selectedSessionSnapshot: unknown | null) {
    this.state = { ...this.state, selectedSessionSnapshot };
    this.emitChange();
  }

  async poll() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollOnce().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  reset(cursor = 0) {
    const nextCursor = normalizeCursor(cursor);
    if (nextCursor === this.state.cursor) return;
    // The cursor is transport metadata. Keep the main store snapshot identity
    // stable so advancing it cannot re-render the whole Threadex shell.
    this.state.cursor = nextCursor;
    persistCursor(this.state.cursor);
    this.emitCursorChange();
  }

  private async pollOnce() {
    const response = await fetch(`/api/events?after=${this.state.cursor}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = (await response.json()) as EventsResponse;
    if (payload.resetRequired) return true;

    const nextStatusMonitor = Array.isArray(payload.statusMonitor) ? payload.statusMonitor : this.state.statusMonitor;
    const grillSummaries = reuseJsonValue(this.state.grillSummaries, payload.grillSummaries?.map((item) => {
      const local = this.state.grillSummaries.find((old) => old.sessionId === item.sessionId && old.turnId === item.turnId);
      return local && local.revision > item.revision ? local : item;
    }) ?? this.state.grillSummaries);
    const nextProcessMonitors = Array.isArray(payload.processMonitors) ? payload.processMonitors : [];
    const nextWaitEvents = Array.isArray(payload.waitEvents) ? payload.waitEvents : this.state.waitEvents;
    const nextWaitSubscriptions = Array.isArray(payload.waitSubscriptions) ? payload.waitSubscriptions : this.state.waitSubscriptions;
    const statusMonitor = reuseJsonValue(this.state.statusMonitor, nextStatusMonitor);
    const processMonitors = reuseJsonValue(this.state.processMonitors, nextProcessMonitors);
    const waitEvents = reuseJsonValue(this.state.waitEvents, nextWaitEvents);
    const waitSubscriptions = reuseJsonValue(this.state.waitSubscriptions, nextWaitSubscriptions);

    const events = Array.isArray(payload.events) ? payload.events : [];
    let cursor = this.state.cursor;
    for (const event of events) {
      if (!isRingEvent(event) || event.pos <= cursor) continue;
      cursor = event.pos;
      this.emitEvent(event);
    }
    if (typeof payload.nextPos === "number") cursor = Math.max(cursor, normalizeCursor(payload.nextPos));
    // Event listeners can synchronously install a newer workspace snapshot.
    // Never let this older poll response move the delivery cursor backwards.
    cursor = Math.max(cursor, this.state.cursor);
    const cursorChanged = cursor !== this.state.cursor;
    const visibleStateChanged =
      grillSummaries !== this.state.grillSummaries ||
      statusMonitor !== this.state.statusMonitor ||
      processMonitors !== this.state.processMonitors ||
      waitEvents !== this.state.waitEvents ||
      waitSubscriptions !== this.state.waitSubscriptions;
    if (visibleStateChanged) {
      this.state = { ...this.state, cursor, statusMonitor, processMonitors, waitEvents, waitSubscriptions, grillSummaries };
      this.emitChange();
    } else if (cursorChanged) {
      // Mutating only this non-rendered field preserves getState() identity for
      // useSyncExternalStore while getCursor() remains current.
      this.state.cursor = cursor;
    }
    if (cursorChanged) {
      persistCursor(cursor);
      this.emitCursorChange();
    }
    return false;
  }

  private emitEvent(event: RingEvent) {
    for (const type of [event.type, "*"]) {
      for (const listener of this.eventListeners.get(type) ?? []) {
        try {
          listener(event);
        } catch (error) {
          console.error(`Event subscriber failed for ${event.type}`, error);
        }
      }
    }
  }

  private emitChange() {
    for (const listener of this.listeners) listener();
  }

  private emitCursorChange() {
    for (const listener of this.cursorListeners) listener();
  }
}

function reuseJsonValue<T>(current: T, next: T): T {
  return jsonValuesEqual(current, next) ? current : next;
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

function readProcessMonitors(value: unknown): ProcessMonitor[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const monitors = (value as { processMonitors?: unknown }).processMonitors;
  return Array.isArray(monitors) ? monitors as ProcessMonitor[] : [];
}

function readArrayField<T>(value: unknown, field: string): T[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as Record<string, unknown>)[field];
  return Array.isArray(items) ? items as T[] : [];
}

export const eventStore = new EventStore();

export function useEventStore() {
  return useSyncExternalStore(eventStore.subscribe, eventStore.getState, eventStore.getState);
}

export function useEventCursor() {
  return useSyncExternalStore(eventStore.subscribeCursor, eventStore.getCursor, eventStore.getCursor);
}

function readStoredCursor() {
  if (typeof window === "undefined") return 0;
  return normalizeCursor(Number(window.localStorage.getItem(CURSOR_STORAGE_KEY)));
}

function persistCursor(cursor: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CURSOR_STORAGE_KEY, String(cursor));
  } catch {
    // Event delivery still works when storage is unavailable.
  }
}

function normalizeCursor(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRingEvent(value: unknown): value is RingEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RingEvent>;
  return (
    Number.isSafeInteger(event.pos) &&
    typeof event.eventId === "string" &&
    typeof event.type === "string" &&
    typeof event.timestamp === "string"
  );
}

function mergeRecordsById(current: unknown[], incoming: unknown[]) {
  const merged = [...current];
  const indexes = new Map<string, number>();
  current.forEach((record, index) => {
    const id = recordId(record);
    if (id) indexes.set(id, index);
  });
  for (const record of incoming) {
    const id = recordId(record);
    const existingIndex = id ? indexes.get(id) : undefined;
    if (existingIndex !== undefined) {
      merged[existingIndex] = record;
    } else {
      if (id) indexes.set(id, merged.length);
      merged.push(record);
    }
  }
  return merged;
}

function recordId(value: unknown) {
  return value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : null;
}
