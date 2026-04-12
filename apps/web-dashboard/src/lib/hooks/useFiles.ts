"use client";

import useSWR from "swr";
import { fetchFiles } from "../api";
import type { FileEntryInfo } from "../types";

/**
 * Fetch the directory listing for `path`.
 *
 * Realtime is handled by `useFileRealtime` which invalidates this cache on
 * every incoming droplet/files/{user}/* MQTT event, so we no longer poll.
 * We still revalidate on focus so switching tabs feels immediate.
 */
export function useFiles(path: string) {
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    `/api/files?path=${path}`,
    () => fetchFiles(path),
    { revalidateOnFocus: true }
  );

  return {
    files: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
