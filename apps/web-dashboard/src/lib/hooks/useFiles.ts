"use client";

import useSWR from "swr";
import { fetchFiles } from "../api";
import type { FileEntryInfo, FileSpaceId } from "../types";

/**
 * Fetch the directory listing for `path` within a space (default personal).
 *
 * Realtime is handled by `useFileRealtime` which invalidates this cache on
 * every incoming droplet/files/{user}/* MQTT event, so we no longer poll.
 * We still revalidate on focus so switching tabs feels immediate.
 *
 * WARP-883: the SWR key includes the space so My Files and Shared keep
 * independent caches; the personal key is byte-identical to before.
 *
 * WARP-1623: "the space" means EVERY space, not just Shared. The key used to
 * name `shared` literally, so a department listing and the personal listing at
 * the same path collapsed onto one cache entry and served each other's
 * contents. Mirrors the request URL `fetchFiles` now builds.
 */
export function useFiles(path: string, space: FileSpaceId = "personal") {
  const key =
    space === "personal"
      ? `/api/files?path=${path}`
      : `/api/files?space=${space}&path=${path}`;
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    key,
    () => fetchFiles(path, space),
    { revalidateOnFocus: true }
  );

  return {
    files: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
