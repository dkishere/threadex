let pending: Promise<ServiceWorkerRegistration> | undefined;

export function ensureNotificationWorker(): Promise<ServiceWorkerRegistration> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return Promise.reject(new Error("Notifications require HTTPS and service worker support."));
  }
  if (!pending) {
    pending = (async () => {
      const registration = await navigator.serviceWorker.register(
        import.meta.env.DEV ? "/notification-sw.js" : "/sw.js",
        { scope: "/", updateViaCache: "none" }
      );
      if (registration.active) return registration;
      return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Notification worker activation timed out.")), 15000);
        void navigator.serviceWorker.ready.then((ready) => {
          window.clearTimeout(timeout);
          resolve(ready);
        }, (error) => {
          window.clearTimeout(timeout);
          reject(error);
        });
      });
    })().catch((error) => { pending = undefined; throw error; });
  }
  return pending;
}
