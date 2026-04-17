"use client";
import useSWR from "swr";
import type { ScheduleEvent } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

/**
 * When `enabled === false` we return a null key so SWR suspends the fetch —
 * this lets the activity feed avoid requesting data while collapsed.
 */
export function useScheduleEvents(
  opts: { limit?: number; enabled?: boolean } = {},
) {
  const limit = opts.limit ?? 50;
  const key =
    opts.enabled === false ? null : `/api/network/schedule-events?limit=${limit}`;
  return useSWR<{ events: ScheduleEvent[] }>(key, fetcher, {
    refreshInterval: 60_000,
  });
}
