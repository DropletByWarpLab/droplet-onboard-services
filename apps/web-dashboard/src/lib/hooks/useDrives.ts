"use client";

import useSWR from "swr";
import { fetchDrives } from "../api";
import type { DrivesResponse } from "../types";

export function useDrives() {
  const { data, error, isLoading } = useSWR<DrivesResponse>(
    "/api/storage/drives",
    fetchDrives,
    { refreshInterval: 30000 }
  );

  return {
    drives: data?.drives ?? [],
    isLoading,
    error,
    bridgeError: data?.error,
  };
}
