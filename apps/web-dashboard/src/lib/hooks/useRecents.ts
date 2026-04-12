"use client";

import useSWR from "swr";
import { fetchRecents } from "../api";
import type { FileEntryInfo } from "../types";

export function useRecents(limit = 50) {
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    `/api/files/recents?limit=${limit}`,
    () => fetchRecents(limit),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );

  return {
    items: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
