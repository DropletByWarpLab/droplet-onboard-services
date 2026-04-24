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
import { useToast } from "./Toast";
import { useAuth } from "@/lib/auth";

interface IncomingNotification {
  kind?: "reminder" | "event" | "system" | "ai";
  title?: string;
  body?: string | null;
  at?: string;
}

export function NotificationToaster() {
  const { toast } = useToast();
  const { user } = useAuth();
  const toastRef = useRef(toast);
  toastRef.current = toast;

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
        const title = payload.title ?? "Notification";
        const body = payload.body ? `${title} — ${payload.body}` : title;
        toastRef.current(body, payload.kind === "ai" ? "info" : "success");
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
