/* Droplet dashboard service worker.
 *
 * Single responsibility: receive Web Push notifications from the
 * orchestrator and surface them as native OS notifications. The
 * orchestrator's push payload is a JSON string of:
 *   { title, body, url?, tag?, imageUrl?, data?, notificationId? }
 * mirroring the PushPayload shape in services/push-dispatch.service.ts.
 *
 * On notification click we focus an existing dashboard tab (or open
 * a new one) at the payload's `url`, with a fallback to /cameras.
 *
 * WARP-2804 — a tap is the person opening it, so when the push carried the
 * NotificationLog row's `notificationId` the click also acknowledges that
 * row (`POST /api/notifications/<id>/ack {"via":"opened"}`, same-origin, so
 * the SameSite=Lax session cookie rides along). The ack is sent alongside the
 * focus/navigation, never ahead of it: browsers allow openWindow/focus only
 * for a short time after the click, and a slow network must not eat that
 * window. A failed ack is swallowed; the row stays unread and findable.
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
    // WARP-2909 — `url` LAST so a `data.url` can never override the link the
    // box validated (the box also refuses a `data.url` key outright).
    // WARP-2804 — `notificationId` last for the same reason: only the box's
    // own id for this push is ever acked, never one smuggled in `data`.
    data: { ...(payload.data || {}), url: payload.url || "/cameras", notificationId: payload.notificationId },
    // Keep the notification in the tray until dismissed — security
    // events are easy to miss otherwise.
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/** A NotificationLog id (cuid): the same shape the ack route accepts. */
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** WARP-2804 — acknowledge the tapped notification as opened. Never rejects. */
function ackOpened(data) {
  const id = data && data.notificationId;
  if (typeof id !== "string" || !NOTIFICATION_ID_RE.test(id)) return Promise.resolve();
  return fetch(`/api/notifications/${encodeURIComponent(id)}/ack`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: '{"via":"opened"}',
  }).catch(() => {
    // Offline or refused: the row stays unread in the inbox. Nothing to show here.
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/cameras";
  // Started first, awaited last: the focus/navigation below never waits on it.
  const ack = ackOpened(event.notification.data);

  const open = (async () => {
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
  })();

  // Keep the worker alive until both have settled.
  event.waitUntil(Promise.all([open, ack]));
});
