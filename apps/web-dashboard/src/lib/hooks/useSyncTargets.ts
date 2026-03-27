"use client";

import useSWR from "swr";
import { fetchSyncTargets } from "../api";
import type { SyncTargetInfo } from "../types";

export function useSyncTargets() {
  const { data, error, isLoading, mutate } = useSWR<SyncTargetInfo[]>(
    "/api/sync/targets",
    fetchSyncTargets,
    { refreshInterval: 10000 }
  );

  return {
    targets: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
