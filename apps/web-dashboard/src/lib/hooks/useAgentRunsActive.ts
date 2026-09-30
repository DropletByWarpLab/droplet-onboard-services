"use client";
/**
 * WARP-3303 — the Workshop nav badge: how many background runs are still
 * going (queued, running or waiting for an OK), and whether one needs you.
 *
 * One list read on load, then re-read when a `droplet/agent-runs/<user>`
 * frame arrives (SWR's 2 s de-duplication absorbs a run's per-step frames).
 * Fail-quiet like the team-chat badge: an error reads 0, never attention.
 */
import { useEffect } from "react";
import useSWR from "swr";
import { listAgentRuns, LIVE_STATUSES } from "@/components/workshop/agent-runs/api";
import { subscribeAgentRunEvents } from "@/lib/agent-run-events";

export const AGENT_RUNS_ACTIVE_KEY = "/api/agent-runs#active";

export function useAgentRunsActive(enabled: boolean): { count: number; needsYou: boolean } {
  const { data, mutate } = useSWR(
    enabled ? AGENT_RUNS_ACTIVE_KEY : null,
    async () => {
      const { items } = await listAgentRuns({ limit: 50 });
      const live = items.filter((r) => LIVE_STATUSES.has(r.status));
      return { count: live.length, needsYou: live.some((r) => r.status === "awaiting_confirmation") };
    },
    { shouldRetryOnError: false },
  );
  useEffect(() => {
    if (!enabled) return;
    return subscribeAgentRunEvents(() => void mutate());
  }, [enabled, mutate]);
  return data ?? { count: 0, needsYou: false };
}
