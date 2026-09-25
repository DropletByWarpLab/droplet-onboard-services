"use client";

import useSWR from "swr";
import { isFilesUnavailableError } from "../files-unavailable";
import { fetchRecents } from "../api";
import type { FileEntryInfo } from "../types";

export function useRecents(limit = 50) {
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    `/api/files/recents?limit=${limit}`,
    () => fetchRecents(limit),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );

  return {
    // WARP-3076 — SWR keeps the last good data on error; during an outage
    // those rows (and their actions) must not stay on screen.
    items: isFilesUnavailableError(error) ? [] : data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
