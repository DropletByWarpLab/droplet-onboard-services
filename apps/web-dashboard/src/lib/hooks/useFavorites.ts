"use client";

import useSWR from "swr";
import { fetchFavorites } from "../api";
import type { FileEntryInfo } from "../types";

export function useFavorites() {
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    "/api/files/favorites",
    () => fetchFavorites(),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );

  return {
    items: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
