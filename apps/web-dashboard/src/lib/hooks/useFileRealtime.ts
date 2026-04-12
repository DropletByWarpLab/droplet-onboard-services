"use client";

import { useEffect, useRef } from "react";
import { useSWRConfig } from "swr";

/**
 * WebSocket client for `/api/ws/events`. The orchestrator forwards every
 * user-scoped MQTT event (droplet/files/{user}/#, droplet/devices/{user}/#,
 * droplet/index/{user}/#) as a JSON text frame in the shape
 * `{ topic, payload }`.
 *
 * This hook:
 *  - opens the socket on mount and tears it down on unmount
 *  - applies exponential backoff with jitter on reconnect, so a server
 *    restart doesn't cause a thundering-herd revalidation storm
 *  - on any `droplet/files/*` event, invalidates every SWR cache key
 *    starting with `/api/files` (listings, favorites, recents, search,
 *    trash, versions) so the user sees the change within a network RTT
 *    instead of after the next 5s poll
 *  - exposes nothing: it's a fire-and-forget side-effect hook
 */
export function useFileRealtime() {
  const { mutate } = useSWRConfig();
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  useEffect(() => {
    if (typeof window === "undefined") return;

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
        let data: { topic?: string; payload?: unknown };
        try {
          data = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        if (!data.topic) return;

        // Invalidate any SWR cache whose key looks like a files endpoint.
        // Covers /api/files?path=..., /api/files/favorites, /api/files/recents,
        // /api/files/trash, /api/files/versions?path=...
        if (data.topic.startsWith("droplet/files/")) {
          mutateRef.current(
            (key) =>
              typeof key === "string" &&
              (key.startsWith("/api/files") || key.startsWith("/api/storage")),
            undefined,
            { revalidate: true }
          );
        }
      };

      ws.onclose = () => {
        if (!closed) scheduleReconnect();
      };

      ws.onerror = () => {
        // Close will fire right after — don't double-schedule.
        ws?.close();
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      // Exponential backoff: 500ms, 1s, 2s, 4s, 8s, cap at 30s.
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
      const jitter = Math.random() * base * 0.25;
      const delay = base + jitter;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);
}
