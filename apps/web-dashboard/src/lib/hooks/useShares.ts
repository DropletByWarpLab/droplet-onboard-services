"use client";

import useSWR from "swr";
import { isFilesUnavailableError } from "../files-unavailable";
import { fetchSharedWithMe, fetchSharedByMe } from "../api";
import type { ShareDetail } from "../types";

export function useSharedWithMe() {
  const { data, error, isLoading, mutate } = useSWR<ShareDetail[]>(
    "/api/files/shared-with-me",
    () => fetchSharedWithMe(),
    { refreshInterval: 30_000, revalidateOnFocus: true }
  );

  return {
    // WARP-3076 — drop stale rows during an outage (see useTrash).
    items: isFilesUnavailableError(error) ? [] : data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}

/**
 * WARP-941 — outbound shares (everything the current user has shared).
 * Mirrors useSharedWithMe for the "Shared by me" tab.
 */
export function useSharedByMe() {
  const { data, error, isLoading, mutate } = useSWR<ShareDetail[]>(
    "/api/files/shares-by-me",
    () => fetchSharedByMe(),
    { refreshInterval: 30_000, revalidateOnFocus: true }
  );

  return {
    // WARP-3076 — drop stale rows during an outage (see useTrash).
    items: isFilesUnavailableError(error) ? [] : data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
