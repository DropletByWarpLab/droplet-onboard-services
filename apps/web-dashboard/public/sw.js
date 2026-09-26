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
 * window. The tap usually comes long after the push, when the 15-minute
 * session cookie has expired, so an ack the box refuses (or a network
 * failure) is HANDED OFF to the dashboard page, which acks through authFetch
 * (review F1; see handOff). If no page takes it within a minute, the row
 * stays unread and findable.
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

/** How long an ack the worker could not make waits for a dashboard page. */
const HANDOFF_WAIT_MS = 60000;

/**
 * WARP-2804 (review F1) — acks the worker could not make, waiting for a
 * signed-in dashboard page to take them: notificationId → release().
 */
const pendingAcks = new Map();

/** The tapped notification's row id, when it is one. */
function ackIdOf(data) {
  const id = data && data.notificationId;
  return typeof id === "string" && NOTIFICATION_ID_RE.test(id) ? id : null;
}

/** WARP-2804 — acknowledge the tapped notification as opened. Resolves true
 *  when the box took it; never rejects, never refreshes the session. */
function ackOpened(id) {
  return fetch(`/api/notifications/${encodeURIComponent(id)}/ack`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: '{"via":"opened"}',
  }).then(
    (res) => Boolean(res && res.ok),
    () => false,
  );
}

function postAck(client, id) {
  try {
    client.postMessage({ type: "ack-notification", id });
  } catch {
    // A client that went away between the click and here: the hand-off waits.
  }
}

/**
 * Review F1 — hand an ack the worker could not make to the dashboard page,
 * which acks through authFetch (refreshing the session, which this worker must
 * never do: the refresh cookie is scoped to /api/auth, and a refresh here
 * would race the page's refresh-token rotation). Posted straight to the window
 * the click focused or opened, AND kept pending until a signed-in dashboard
 * page says it is listening ("dashboard-ready"): a page that was just opened
 * or navigated has not mounted its listener yet, and openWindow may have
 * returned no client at all. Resolves when a page takes it, or after
 * HANDOFF_WAIT_MS (the row then stays unread and findable).
 */
function handOff(id, client) {
  if (client) postAck(client, id);
  const earlier = pendingAcks.get(id);
  if (earlier) earlier();
  return new Promise((resolve) => {
    const release = () => {
      clearTimeout(timer);
      if (pendingAcks.get(id) === release) pendingAcks.delete(id);
      resolve();
    };
    const timer = setTimeout(release, HANDOFF_WAIT_MS);
    pendingAcks.set(id, release);
  });
}

/** A signed-in dashboard page is listening: hand it every pending ack. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "dashboard-ready") return;
  const client = event.source;
  if (!client || typeof client.postMessage !== "function") return;
  for (const [id, release] of [...pendingAcks]) {
    postAck(client, id);
    release();
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/cameras";
  const id = ackIdOf(event.notification.data);
  // Started first, awaited last: the focus/navigation below never waits on it.
  const ack = id ? ackOpened(id) : Promise.resolve(true);

  /** The window the click ends up in, or null. */
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
            // navigate() resolves with the WindowClient of the new document.
            return (await client.navigate(url)) || client;
          } catch {
            // Some browsers reject cross-document navigation here;
            // postMessage to let the dashboard route itself.
            client.postMessage({ type: "navigate", url });
          }
        }
        return client;
      }
    }
    return self.clients.openWindow(url);
  })().catch(() => null);

  // Keep the worker alive until both have settled — and, when the ack failed,
  // until the page takes it over (or the hand-off times out).
  event.waitUntil(
    Promise.all([open, ack]).then(([client, acked]) => (acked || !id ? undefined : handOff(id, client))),
  );
});
