"use client";

import useSWR from "swr";
import { fetchTrash } from "../api";
import type { TrashItemInfo } from "../types";

export function useTrash() {
  const { data, error, isLoading, mutate } = useSWR<TrashItemInfo[]>(
    "/api/files/trash",
    () => fetchTrash(),
    { refreshInterval: 10_000, revalidateOnFocus: true }
  );

  return {
    items: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
