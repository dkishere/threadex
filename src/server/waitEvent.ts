import type {
  CreateWaitEventInput,
  CreateWaitSubscriptionInput,
  SessionStore,
  WaitEventRecord,
  WaitSubscriptionRecord
} from "./sessionStore";

export type WaitEventDispatch = (subscription: WaitSubscriptionRecord, event: WaitEventRecord) => Promise<void>;

type WaitEventServiceOptions = {
  onDispatch?: WaitEventDispatch;
};

const maxTimerDelayMs = 2_147_000_000;

/**
 * Durable backend control plane for conditions shared by one or more sessions.
 * PostgreSQL is authoritative; timers only accelerate events with expected_at.
 */
export class WaitEventService {
  private timers = new Map<string, NodeJS.Timeout>();
  private dispatching = new Set<string>();
  private stopped = true;

  constructor(
    private readonly store: SessionStore,
    private readonly options: WaitEventServiceOptions = {}
  ) {}

  async start() {
    this.stopped = false;
    const subscriptions = await this.store.listWaitSubscriptions();
    for (const subscription of subscriptions) {
      if (subscription.status === "dispatching") {
        await this.store.retryWaitSubscription(subscription.id);
      }
    }

    const events = await this.store.listWaitEvents();
    for (const event of events) {
      if (event.status === "pending") {
        this.schedule(event);
      } else if (event.status === "fired") {
        await this.dispatchEvent(event);
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async ensureEvent(input: CreateWaitEventInput) {
    const event = await this.store.ensureWaitEvent(input);
    if (event.status === "pending") this.schedule(event);
    if (event.status === "fired") await this.dispatchEvent(event);
    return event;
  }

  async subscribe(input: CreateWaitSubscriptionInput) {
    const event = await this.store.getWaitEvent(input.eventId);
    if (!event) throw new Error(`Wait event ${input.eventId} not found.`);
    const subscription = await this.store.createWaitSubscription(input);
    if (event.status === "fired" && subscription.status === "waiting") {
      await this.dispatchSubscription(subscription, event);
      return (await this.store.listWaitSubscriptions({ eventId: event.id }))
        .find((candidate) => candidate.id === subscription.id) ?? subscription;
    }
    return subscription;
  }

  async updateSubscriptionPrompt(subscriptionId: string, prompt: string) {
    const subscription = await this.store.updateWaitSubscriptionPrompt(subscriptionId, prompt);
    const event = await this.store.getWaitEvent(subscription.eventId);
    if (event?.status === "fired" && subscription.status === "waiting") {
      await this.dispatchSubscription(subscription, event);
      return await this.store.getWaitSubscription(subscription.id) ?? subscription;
    }
    return subscription;
  }

  async cancelSubscription(subscriptionId: string) {
    return this.store.cancelWaitSubscription(subscriptionId);
  }

  async fire(eventId: string, payload?: unknown) {
    this.clearTimer(eventId);
    const previous = await this.store.getWaitEvent(eventId);
    if (!previous) throw new Error(`Wait event ${eventId} not found.`);
    const event = previous.status === "fired"
      ? previous
      : await this.store.fireWaitEvent(eventId, payload === undefined ? previous.payload : payload);
    if (!event) throw new Error(`Wait event ${eventId} not found.`);
    if (event.status === "fired") await this.dispatchEvent(event);
    return event;
  }

  async cancel(eventId: string) {
    this.clearTimer(eventId);
    return this.store.cancelWaitEvent(eventId);
  }

  private schedule(event: WaitEventRecord) {
    this.clearTimer(event.id);
    if (this.stopped || !event.expectedAt) return;
    const expectedAt = Date.parse(event.expectedAt);
    if (!Number.isFinite(expectedAt)) return;
    const delay = Math.max(0, expectedAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(event.id);
      if (delay > maxTimerDelayMs) {
        void this.refreshAndSchedule(event.id);
        return;
      }
      void this.fire(event.id).catch((error) => {
        console.warn(`Failed to fire wait event ${event.id}: ${errorMessage(error)}`);
      });
    }, Math.min(delay, maxTimerDelayMs));
    timer.unref();
    this.timers.set(event.id, timer);
  }

  private async refreshAndSchedule(eventId: string) {
    const event = await this.store.getWaitEvent(eventId);
    if (event?.status === "pending") this.schedule(event);
  }

  private clearTimer(eventId: string) {
    const timer = this.timers.get(eventId);
    if (timer) clearTimeout(timer);
    this.timers.delete(eventId);
  }

  private async dispatchEvent(event: WaitEventRecord) {
    const subscriptions = await this.store.listWaitSubscriptions({ eventId: event.id, status: "waiting" });
    await Promise.all(subscriptions.map((subscription) => this.dispatchSubscription(subscription, event)));
  }

  private async dispatchSubscription(subscription: WaitSubscriptionRecord, event: WaitEventRecord) {
    if (this.dispatching.has(subscription.id)) return;
    this.dispatching.add(subscription.id);
    try {
      const claimed = await this.store.claimWaitSubscription(subscription.id);
      if (!claimed) return;
      if (!this.options.onDispatch) throw new Error("Wait event dispatch is not configured.");
      await this.options.onDispatch(claimed, event);
      await this.store.completeWaitSubscription(claimed.id);
    } catch (error) {
      await this.store.failWaitSubscription(subscription.id, errorMessage(error));
    } finally {
      this.dispatching.delete(subscription.id);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
