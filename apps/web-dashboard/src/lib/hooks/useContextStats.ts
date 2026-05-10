"use client";

/**
 * WARP-225 — SWR hooks for /api/me/context-stats/*.
 *
 * Polling cadence is paired to the orchestrator's Redis cache TTLs
 * (see context-stats.service.ts):
 *   - summary  → 30s  (home widget — lightweight)
 *   - full     → 60s  (deep-dive page — heavy)
 *   - queued   → 60s  (drill-down — 5min cache, but the user expects
 *                       responsiveness when they click "Run now")
 *   - failed   → 60s  (same — retry feedback should be quick)
 *
 * MQTT-driven cache invalidation on the orchestrator side means the
 * 30s/60s polls usually return fresh data even when something changed
 * mid-cycle. We don't try to be smarter than that — no SSE, no
 * WebSocket; the spec calls polling the visual-experience target.
 */

import useSWR from "swr";
import {
  fetchContextStatsSummary,
  fetchContextStatsFull,
  fetchContextStatsQueued,
  fetchContextStatsFailed,
} from "../api";
import type {
  ContextStatsSummary,
  ContextStatsFull,
  QueuedItem,
  FailedItem,
} from "../types-context-stats";

export function useContextStatsSummary() {
  const { data, error, isLoading, mutate } = useSWR<ContextStatsSummary>(
    "/api/me/context-stats",
    fetchContextStatsSummary,
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );
  return { summary: data ?? null, isLoading, error, mutate };
}

export function useContextStatsFull() {
  const { data, error, isLoading, mutate } = useSWR<ContextStatsFull>(
    "/api/me/context-stats/full",
    fetchContextStatsFull,
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );
  return { full: data ?? null, isLoading, error, mutate };
}

export function useContextStatsQueued(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<QueuedItem[]>(
    enabled ? "/api/me/context-stats/queued" : null,
    fetchContextStatsQueued,
    { refreshInterval: 60_000 },
  );
  return { queued: data ?? [], isLoading, error, mutate };
}

export function useContextStatsFailed(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<FailedItem[]>(
    enabled ? "/api/me/context-stats/failed" : null,
    fetchContextStatsFailed,
    { refreshInterval: 60_000 },
  );
  return { failed: data ?? [], isLoading, error, mutate };
}
