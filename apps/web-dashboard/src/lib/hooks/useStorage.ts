"use client";

import useSWR from "swr";
import { fetchStorage } from "../api";
import type { StorageStats } from "../types";

export function useStorage() {
  const { data, error, isLoading } = useSWR<StorageStats>(
    "/api/storage",
    fetchStorage,
    { refreshInterval: 30000 }
  );

  return {
    storage: data ?? null,
    isLoading,
    error,
  };
}
