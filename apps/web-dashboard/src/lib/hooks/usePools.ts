"use client";

import useSWR from "swr";
import { fetchPools } from "../api";
import type { PoolsResponse } from "../types";

/** BUG-3 / ADR-019: read-only mdadm pool inventory. `pools` is [] when no
 *  array exists (honest, never a fabricated sum). `bridgeError` mirrors
 *  useDrives so the panel can branch on an unreachable storage service. */
export function usePools() {
  const { data, error, isLoading, mutate } = useSWR<PoolsResponse>(
    "/api/storage/pools",
    fetchPools,
    { refreshInterval: 30000 },
  );

  return {
    pools: data?.pools ?? [],
    isLoading,
    error,
    bridgeError:
      data?.error ??
      (data?.reason === "bridge_unavailable" ? "bridge_unavailable" : undefined),
    refresh: mutate,
  };
}
