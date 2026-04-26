/* Droplet dashboard service worker.
 *
 * Single responsibility: receive Web Push notifications from the
 * orchestrator and surface them as native OS notifications. The
 * orchestrator's push payload is a JSON string of:
 *   { title, body, url?, tag?, imageUrl?, data? }
 * mirroring the PushPayload shape in services/push-dispatch.service.ts.
 *
 * On notification click we focus an existing dashboard tab (or open
 * a new one) at the payload's `url`, with a fallback to /cameras.
 *
 * No caching. The dashboard's main bundle is served by Next.js with
 * its own cache rules; the SW exists purely to register a push
 * receiver. We claim() so the very first install starts handling
 * pushes without a page reload.
 */

self.addEventListener("install", (event) => {
  // Skip the standard "wait until next reload" stage so the SW can
  // immediately receive pushes.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Droplet", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Droplet";
  const options = {
    body: payload.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag,
    image: payload.imageUrl,
    data: { url: payload.url || "/cameras", ...(payload.data || {}) },
    // Keep the notification in the tray until dismissed — security
    // events are easy to miss otherwise.
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/cameras";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer focusing an existing dashboard tab over opening a new
      // one — operators usually have the app pinned.
      for (const client of all) {
        if (client.url && new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Some browsers reject cross-document navigation here;
              // postMessage to let the dashboard route itself.
              client.postMessage({ type: "navigate", url });
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
