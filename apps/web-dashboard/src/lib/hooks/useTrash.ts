"use client";

import useSWR from "swr";
import { isFilesUnavailableError } from "../files-unavailable";
import { fetchTrash } from "../api";
import type { TrashItemInfo } from "../types";

export function useTrash() {
  const { data, error, isLoading, mutate } = useSWR<TrashItemInfo[]>(
    "/api/files/trash",
    () => fetchTrash(),
    { refreshInterval: 10_000, revalidateOnFocus: true }
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
