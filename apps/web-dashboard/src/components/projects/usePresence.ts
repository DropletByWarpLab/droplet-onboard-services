"use client";

/**
 * WARP-3536 (Work Suite WS-19) — "Also viewing": the drawer's heartbeat.
 *
 * While a work item's drawer is open, `POST /api/pm/work-items/:id/presence`
 * goes out every 10 s. The server keeps each beat for 20 s, so one lost beat is
 * forgiven and a closed drawer drops off everyone else's screen within 20 s;
 * nothing is sent when the drawer closes. The same response lists the OTHER
 * people on the item (their `User.id`s, resolved to avatars by `usePeople`), so
 * one request is the whole round trip.
 *
 * SWR drives it, which is why a hidden tab is quiet (no polling while hidden:
 * "also viewing" means looking) and why coming back to the tab beats at once.
 *
 * Best-effort, and it must stay out of the way: a refused, rate-limited or
 * failed beat reads as "nobody else", never as an error and never as a log line,
 * and the next beat goes out regardless. Presence is a hint about colleagues,
 * not part of the work item.
 */

import useSWR from "swr";
import { authFetch } from "@/lib/auth";

/** Half the server's 20 s TTL. */
export const PRESENCE_BEAT_MS = 10_000;

async function beat(workItemId: string): Promise<string[]> {
  try {
    const res = await authFetch(`/api/pm/work-items/${encodeURIComponent(workItemId)}/presence`, { method: "POST" });
    if (!res.ok) return [];
    const body = (await res.json()) as { viewers?: unknown };
    return Array.isArray(body?.viewers) ? body.viewers.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The people other than you who have `workItemId` open, refreshed by each beat. */
export function usePresence(workItemId: string | null): string[] {
  const { data } = useSWR(
    // A tuple, not a URL: this is a POST, and no `/api/pm/` key filter (usePmLive) should ever match it.
    workItemId ? (["pm-presence", workItemId] as const) : null,
    ([, id]) => beat(id),
    { refreshInterval: PRESENCE_BEAT_MS, shouldRetryOnError: false },
  );
  return data ?? [];
}
