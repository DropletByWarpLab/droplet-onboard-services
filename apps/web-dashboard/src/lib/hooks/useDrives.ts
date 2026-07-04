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
    isLoading,
    error,
    bridgeError:
      data?.error ??
      (data?.reason === "bridge_unavailable" ? "bridge_unavailable" : undefined),
    refresh: mutate,
  };
}
