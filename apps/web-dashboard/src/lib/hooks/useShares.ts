"use client";

import useSWR from "swr";
import { fetchSharedWithMe } from "../api";
import type { ShareDetail } from "../types";

export function useSharedWithMe() {
  const { data, error, isLoading, mutate } = useSWR<ShareDetail[]>(
    "/api/files/shared-with-me",
    () => fetchSharedWithMe(),
    { refreshInterval: 30_000, revalidateOnFocus: true }
  );

  return {
    items: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
