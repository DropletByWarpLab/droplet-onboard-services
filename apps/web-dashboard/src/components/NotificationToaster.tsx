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
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast, type ToastAction } from "./Toast";
import { useAuth } from "@/lib/auth";

interface IncomingNotification {
  kind?: "reminder" | "event" | "system" | "ai";
  title?: string;
  body?: string | null;
  at?: string;
  /** WARP-2909 — a same-origin dashboard path to open (e.g. a parked run). */
  url?: string;
}

/** WARP-2909 — the box validates `url`, but the toaster never trusts a wire
 *  value it navigates to: only an in-app path, never `//host` or a scheme. */
export function isInAppPath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
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
  const { toast } = useToast();
  const { user } = useAuth();
  const router = useRouter();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const routerRef = useRef(router);
  routerRef.current = router;

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
        const action: ToastAction | undefined = isInAppPath(link)
          ? { label: "Open", onClick: () => routerRef.current.push(link) }
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

  return null;
}
