// Development notifications: leave all network requests and Vite HMR untouched.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);
  if (url.origin === self.location.origin) event.waitUntil(self.clients.openWindow(url.href));
});
