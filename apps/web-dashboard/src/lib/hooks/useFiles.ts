"use client";

import useSWR from "swr";
import { fetchFiles } from "../api";
import type { FileEntryInfo } from "../types";

export function useFiles(path: string) {
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    `/api/files?path=${path}`,
    () => fetchFiles(path),
    { refreshInterval: 5000, revalidateOnFocus: true }
  );

  return {
    files: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
