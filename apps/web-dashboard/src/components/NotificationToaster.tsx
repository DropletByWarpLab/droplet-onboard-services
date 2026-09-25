"use client";

/**
 * Listens to the orchestrator's WebSocket bridge for the user's notification
 * channel (`droplet/notifications/{user}`) and shows each one as an in-app
 * toast. Hooks into the existing ToastProvider so styling stays consistent
 * with the rest of the app.
 *
 * Mounted once at the layout level. Reconnects on backoff like the file
 * realtime hook so a server bounce doesn't leave the user without
 * notifications.
 *
 * WARP-2804 — acknowledgement. The payload carries the NotificationLog `id`,
 * and choosing "Open" acknowledges that row as `opened` before navigating
 * (fire-and-forget: a failed ack never blocks the navigation). A toast that
 * times out or is dismissed is NOT an acknowledgement — nobody can prove it
 * was read. A payload without an `id` (an older box) is never acked.
 *
 * Review F1 — also the page end of the service worker (public/sw.js). A push
 * is usually tapped long after it arrived, when the 15-minute session cookie
 * has expired, so the worker's own ack gets a 401 — and the worker must not
 * refresh the session (that would race this page's refresh-token rotation).
 * It hands the ack here instead; this page makes it through authFetch, which
 * refreshes. Once signed in, the page tells the worker it is listening
 * ("dashboard-ready") so an ack handed over before the listener existed is
 * delivered then. The worker's `navigate` fallback lands here too.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast, type ToastAction } from "./Toast";
import { useAuth } from "@/lib/auth";
import { ackNotification } from "@/lib/api";
import { SECURITY_WALL_PATH } from "@/lib/routing";

interface IncomingNotification {
  kind?: "reminder" | "event" | "system" | "ai";
  title?: string;
  body?: string | null;
  at?: string;
  /** WARP-2909 — a same-origin dashboard path to open (e.g. a parked run). */
  url?: string;
  /** WARP-2804 — the NotificationLog row this toast is for; "Open" acknowledges it. */
  id?: string;
  /** WARP-2978 fills this (an alert vs a notice). Carried, not yet rendered. */
  priority?: string;
}

/** WARP-2909 — the box validates `url`, but the toaster never trusts a wire
 *  value it navigates to: only an in-app path, never `//host` or a scheme. */
export function isInAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
}

/** A NotificationLog id (cuid): the shape the ack route accepts. */
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** What the service worker may ask of this page. */
export type WorkerMessage = { type: "ack-notification"; id: string } | { type: "navigate"; url: string };

/** The worker's message, validated — or null for anything malformed or foreign. */
export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (data === null || typeof data !== "object") return null;
  const msg = data as { type?: unknown; id?: unknown; url?: unknown };
  if (msg.type === "ack-notification" && typeof msg.id === "string" && NOTIFICATION_ID_RE.test(msg.id)) {
    return { type: "ack-notification", id: msg.id };
  }
  if (msg.type === "navigate" && isInAppPath(msg.url)) return { type: "navigate", url: msg.url };
  return null;
}

// When the server didn't ship a title, prefer a kind-derived Title Case
// label over the generic word "Notification". Falls back to
// "New notification" when there's no kind either. WARP-297.
function kindFallbackTitle(kind?: IncomingNotification["kind"]): string {
  switch (kind) {
    case "reminder":
      return "Reminder";
    case "event":
      return "Event";
    case "system":
      return "System notification";
    case "ai":
      return "AI";
    default:
      return "New notification";
  }
}

export function NotificationToaster() {
  const { toast, dismissAll } = useToast();
  const { user } = useAuth();
  const router = useRouter();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const routerRef = useRef(router);
  routerRef.current = router;

  // WARP-2992 — a toast belongs to the person it was shown to: a notification's
  // body, a file name in an upload error. Error toasts stay until dismissed
  // (WCAG 2.2.1) and the stack lives in the layout, above the session, so one
  // raised just before sign-out was still on screen for the next person to
  // sign in on this tab. This is the one layout-level component that sees both
  // the session and the stack, so it clears the stack when a signed-in
  // identity ENDS — not when one begins, so a toast raised on /login survives
  // the sign-in it was about.
  const userId = user?.id ?? null;
  const shownTo = useRef(userId);
  useEffect(() => {
    if (shownTo.current !== null && shownTo.current !== userId) dismissAll();
    shownTo.current = userId;
  }, [userId, dismissAll]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!user) return; // wait until login

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/events`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (event) => {
        // WARP-2981 (ADR-059 §3.8) — no toast on the Security wall: it faces a
        // room, and this person's reminders, shares and alert text naming an
        // area are not the room's to read (nor its "Open" theirs to press).
        // Checked per message, so leaving the wall toasts again at once; the
        // socket stays up.
        if (window.location.pathname === SECURITY_WALL_PATH) return;
        let data: { topic?: string; payload?: IncomingNotification };
        try {
          data = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        if (!data.topic || !data.topic.startsWith("droplet/notifications/")) return;
        const payload = data.payload ?? {};
        const title = payload.title ?? kindFallbackTitle(payload.kind);
        // The old shape did `${title} — ${body}` even when title was the
        // generic word "Notification", which shipped "Notification —
        // Notification — ${body}" to screen readers. We only prefix the
        // body with the title when the title is genuinely informative, and
        // otherwise just render the body alone (or the title alone when
        // there is no body).
        const message = payload.body
          ? `${title} — ${payload.body}`
          : title;
        const link = payload.url;
        const id = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;
        const action: ToastAction | undefined = isInAppPath(link)
          ? {
              label: "Open",
              onClick: () => {
                // WARP-2804 — opening it is the acknowledgement. Sent first,
                // never awaited: the navigation must not wait on the network.
                if (id) void ackNotification(id, { via: "opened" }).catch(() => {});
                routerRef.current.push(link);
              },
            }
          : undefined;
        toastRef.current(message, payload.kind === "ai" ? "info" : "success", action);
      };
      ws.onclose = () => scheduleReconnect();
      ws.onerror = () => {
        try { ws?.close(); } catch { /* ignore */ }
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
      attempt++;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [user]);

  // Review F1 — the service worker's hand-offs (see the header).
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const acked = new Set<string>();
    const onMessage = (event: MessageEvent) => {
      const msg = parseWorkerMessage(event.data);
      if (!msg) return;
      if (msg.type === "navigate") {
        routerRef.current.push(msg.url);
        return;
      }
      // The worker may post the same id twice (straight to the window it
      // opened, then again on "dashboard-ready"); the ack is made once.
      if (acked.has(msg.id)) return;
      acked.add(msg.id);
      void ackNotification(msg.id, { via: "opened" }).catch(() => {});
    };
    container.addEventListener("message", onMessage);
    // Signed in and listening: the worker hands over anything pending.
    void container.ready
      .then((registration) => registration.active?.postMessage({ type: "dashboard-ready" }))
      .catch(() => {});
    return () => container.removeEventListener("message", onMessage);
  }, [user]);

  return null;
}
