"use client";

/**
 * WARP-214 — hybrid GET + WS hook for BrainMemoryItem statuses.
 *
 * Initial state from GET /api/files/brain. Subsequent updates from the
 * per-user WS bridge at /api/ws/events (matches the useFileRealtime
 * pattern: exponential backoff + jitter on reconnect, same endpoint).
 * On WS disconnect, falls back to a 5-second poll on the GET until WS
 * reconnects.
 *
 * Returns a Map keyed by itemId so callers can render in any order
 * and merge updates by id without array-shuffle re-renders.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getBrainMemoryItems, type BrainMemoryItemInfo } from "@/lib/api";

interface UseBrainStatusReturn {
  items: Map<string, BrainMemoryItemInfo>;
  loading: boolean;
  error: string | null;
  /** Test-only seam — only populated when NODE_ENV === "test". */
  _testInjectWsMessage?: (msg: { topic: string; payload: unknown }) => void;
}

const POLL_INTERVAL_MS = 5_000;

export function useBrainStatus(): UseBrainStatusReturn {
  const [items, setItems] = useState<Map<string, BrainMemoryItemInfo>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refreshFromGet = useCallback(async () => {
    try {
      const res = await getBrainMemoryItems();
      const next = new Map<string, BrainMemoryItemInfo>();
      for (const item of res.items ?? []) {
        next.set(item.id, item);
      }
      setItems(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? "Failed to load brain memory");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWsMessage = useCallback(
    (msg: { topic?: string; payload?: unknown }) => {
      if (typeof msg?.topic !== "string") return;
      // The orchestrator forwards `droplet/files/{user}/brain/indexed` (and
      // sibling topics) — match by suffix so we don't have to know the user.
      if (!msg.topic.endsWith("/brain/indexed")) return;
      const payload = msg.payload as
        | { itemId?: string; status?: BrainMemoryItemInfo["status"]; failureReason?: string | null }
        | undefined;
      if (!payload || !payload.itemId || !payload.status) return;
      const { itemId, status, failureReason } = payload;
      setItems((prev) => {
        const existing = prev.get(itemId);
        if (!existing) return prev; // ignore unknown items — GET will pick them up
        const next = new Map(prev);
        next.set(itemId, {
          ...existing,
          status,
          failureReason: failureReason ?? existing.failureReason ?? null,
        });
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    void refreshFromGet();
  }, [refreshFromGet]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(() => {
        void refreshFromGet();
      }, POLL_INTERVAL_MS);
    };
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
      const jitter = Math.random() * base * 0.25;
      reconnectTimer = setTimeout(connect, base + jitter);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/events`;
      try {
        ws = new WebSocket(url);
      } catch {
        startPoll();
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        stopPoll();
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(
            typeof event.data === "string" ? event.data : "",
          );
          handleWsMessage(data);
        } catch {
          /* ignore parse failures — the bridge always sends JSON text frames */
        }
      };
      ws.onclose = () => {
        if (!closed) {
          startPoll();
          scheduleReconnect();
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      stopPoll();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [refreshFromGet, handleWsMessage]);

  const out: UseBrainStatusReturn = { items, loading, error };
  if (process.env.NODE_ENV === "test") {
    out._testInjectWsMessage = handleWsMessage;
  }
  return out;
}
