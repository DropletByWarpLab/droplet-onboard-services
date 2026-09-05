"use client";

import useSWR from "swr";
import { fetchDrives } from "../api";
import type { DrivesResponse } from "../types";

export function useDrives() {
  const { data, error, isLoading, mutate } = useSWR<DrivesResponse>(
    "/api/storage/drives",
    fetchDrives,
    { refreshInterval: 30000 }
  );

  return {
    drives: data?.drives ?? [],
    // WARP-936: whole-disk inventory (present-but-unmounted disks included).
    // Empty on an older orchestrator/bridge that predates the field.
    disks: data?.disks ?? [],
    // WARP-2098: total across the DATA drives only — never the system disk,
    // never a sum of pool members. `null` (not zeroes) while loading, when
    // there are no data drives, and on an older orchestrator, so a caller
    // renders an empty state instead of a full-looking 0 B meter.
    totals: data?.totals ?? null,
    // WARP-2098: the box's own install disk, reported separately so it can be
    // SHOWN without ever joining the lists that feed destructive actions.
    // undefined when the bridge doesn't report it — the card is then omitted.
    // Deliberately NOT `?? null`: absent must stay falsy AND distinguishable.
    systemDisk: data?.system_disk,
    isLoading,
    error,
    // WARP-2098 (code review): a failed fetch must be VISIBLE. fetchDrives()
    // throws on a non-ok reply before reading the body, so the `{error}` the
    // orchestrator sends on a bridge 502 never arrives here; SWR keeps the last
    // good `data` and sets its own `error`. Deriving bridgeError from `data`
    // alone therefore rendered the previous totals and system-drive card with
    // nothing marking them stale. SWR's error is the signal for that case, and
    // it clears itself on the next good fetch.
    bridgeError:
      data?.error ??
      (data?.reason === "bridge_unavailable" ? "bridge_unavailable" : undefined) ??
      (error
        ? (error instanceof Error && error.message) || "fetch_failed"
        : undefined),
    refresh: mutate,
  };
}
