// A browser allows about six HTTP/1.1 connections per host, shared by every
// tab with turn streams and API calls. Only the tab holding this lease keeps
// a held event poll open; other visible tabs short-poll as before.
const LEASE_NAME = "threadex.held-event-poll";

export class EventPollLease {
  private release: (() => void) | null = null;
  private requesting: Promise<boolean> | null = null;

  constructor(private readonly locks: LockManager | undefined = globalThis.navigator?.locks) {}

  get held() {
    if (!this.locks) return typeof document !== "undefined" && document.hasFocus();
    return this.release !== null;
  }

  // Take the lease if no other tab has it. Never waits for another holder.
  acquire(): Promise<boolean> {
    if (this.release) return Promise.resolve(true);
    // Without Web Locks (plain http on a LAN address) only a focused window
    // holds, which still bounds held polls to one per browser.
    if (!this.locks) return Promise.resolve(typeof document !== "undefined" && document.hasFocus());
    this.requesting ??= new Promise<boolean>((resolve) => {
      this.locks!.request(LEASE_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise<void>((done) => { this.release = () => { this.release = null; done(); }; });
      }).catch(() => resolve(false));
    }).finally(() => { this.requesting = null; });
    return this.requesting;
  }

  releaseLease() {
    this.release?.();
  }
}
