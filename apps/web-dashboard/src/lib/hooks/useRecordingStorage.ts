"use client";

import useSWR from "swr";
import { fetchRecordingStorage } from "../api";
import type { RecordingStorage, RecordingStorageResult } from "../types";

/**
 * What a surface can be in, given an orchestrator that may or may not have the
 * WARP-3514 endpoint yet:
 *
 *   loading        — first fetch in flight
 *   ready          — `recording` is the (normalised) summary
 *   not_supported  — the endpoint is absent (404): hide, or say "not available
 *                    on this Droplet yet" — never an error
 *   forbidden      — this role may not read it (403): hide
 *   error          — the fetch itself failed (transport / 5xx): "couldn't load"
 *
 * Absent and failed are deliberately different states: "not available yet" and
 * "something broke" call for different words.
 */
export type RecordingStorageState =
  | "loading"
  | "ready"
  | "not_supported"
  | "forbidden"
  | "error";

export interface UseRecordingStorage {
  state: RecordingStorageState;
  /** Non-null exactly when `state === "ready"`. */
  recording: RecordingStorage | null;
  /** True when these facts are cached from the last good response after refresh failed. */
  stale: boolean;
  /** Re-fetch now (e.g. after a mode change or a "Try again"). */
  refresh: () => Promise<unknown>;
}

/** Poll quickly while a move is running so the progress bar moves; otherwise
 *  gently — the numbers change hourly and a drive can go missing at any time. */
const MIGRATING_REFRESH_MS = 4_000;
const IDLE_REFRESH_MS = 30_000;

/**
 * GET /api/storage/recordings, shared by every surface that shows it (the
 * Recording storage card on /cameras/system, the per-camera settings note).
 * One SWR key, so they share a single request. Pass `{ enabled: false }` for a
 * role that may not read it (see the note on the key below).
 */
export function useRecordingStorage(
  { enabled = true }: { enabled?: boolean } = {},
): UseRecordingStorage {
  // `enabled: false` is for a role that is known to get a 403 (a family account:
  // the route and its writes are owner/admin only). SWR with a null key never
  // fetches, so that role never provokes the 403 at all, and the surface sees the
  // same `forbidden` it would have after one.
  const { data, error, mutate } = useSWR<RecordingStorageResult>(
    enabled ? "/api/storage/recordings" : null,
    fetchRecordingStorage,
    {
      refreshInterval: (latest) =>
        latest?.available && latest.data.status === "migrating"
          ? MIGRATING_REFRESH_MS
          : IDLE_REFRESH_MS,
    },
  );

  if (!enabled) return { state: "forbidden", recording: null, stale: false, refresh: mutate };

  // Keep the last good facts visible after a refetch fails, but surface `stale`
  // so surfaces can label them and suppress actions that depend on freshness.
  if (data?.available) {
    return { state: "ready", recording: data.data, stale: Boolean(error), refresh: mutate };
  }
  if (data && !data.available) {
    return { state: data.reason, recording: null, stale: false, refresh: mutate };
  }
  if (error) return { state: "error", recording: null, stale: false, refresh: mutate };
  return { state: "loading", recording: null, stale: false, refresh: mutate };
}
