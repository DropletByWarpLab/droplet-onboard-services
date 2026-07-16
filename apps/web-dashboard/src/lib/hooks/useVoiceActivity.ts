"use client";

/**
 * WARP-1058 — SWR wiring for the /voice "Recent voice activity" feed
 * (§3.4). Kept out of useVoice.ts on purpose: the feed rides the
 * generic signed-activity surface (`/api/activity?kind=voice`), not the
 * voice-io proxy, and its cadence is its own — new rows arrive at
 * human speech pace, so 15 s is plenty (vs the 1 s live-meter poll).
 *
 * `rows: null` means "nothing usable yet" (still loading, or the fetch
 * failed) — the surface renders the §9 empty state either way rather
 * than an error card; the feed is supporting context, never the page's
 * load-bearing content.
 */

import useSWR from "swr";
import { fetchVoiceActivity } from "@/lib/api";
import type { VoiceActivityItem } from "@/lib/types";

export const VOICE_ACTIVITY_KEY = "/api/activity?kind=voice&limit=5";

const FEED_POLL_MS = 15_000;

export function useVoiceActivity(): {
  rows: VoiceActivityItem[] | null;
  refresh: () => void;
} {
  const { data, mutate } = useSWR<VoiceActivityItem[]>(
    VOICE_ACTIVITY_KEY,
    () => fetchVoiceActivity(5),
    { refreshInterval: FEED_POLL_MS, shouldRetryOnError: false },
  );
  return {
    rows: data ?? null,
    refresh: () => {
      void mutate();
    },
  };
}
