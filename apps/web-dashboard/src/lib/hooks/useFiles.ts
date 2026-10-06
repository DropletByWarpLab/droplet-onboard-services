"use client";

import useSWR from "swr";
import { isFilesUnavailableError } from "../files-unavailable";
import { fetchFiles } from "../api";
import type { FileEntryInfo, FileSpaceId } from "../types";

/**
 * Fetch the directory listing for `path` within a space (default personal).
 *
 * `useFileRealtime` invalidates this cache on droplet/files/{user}/* MQTT
 * events. SMB writes and paired Windows sync bypass that event stream, so
 * Droplet, Computers and the personal root also refresh while visible. Root refresh picks up a
 * /Droplet mount registered after the initial listing. Other folders keep
 * using events and focus revalidation.
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
  const watchNetworkDrive =
    space === "personal" &&
    (path === "/" || path === "/Droplet" || path.startsWith("/Droplet/") ||
      path === "/Computers" || path.startsWith("/Computers/"));
  const key =
    space === "personal"
      ? `/api/files?path=${path}`
      : `/api/files?space=${space}&path=${path}`;
  const { data, error, isLoading, mutate } = useSWR<FileEntryInfo[]>(
    key,
    () => fetchFiles(path, space),
    {
      revalidateOnFocus: true,
      // The orchestrator caches directory listings for 10s. Poll after expiry.
      refreshInterval: watchNetworkDrive ? 15_000 : 0,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );

  return {
    // WARP-3076 — SWR keeps the last good data on error; during an outage
    // those rows (and their actions) must not stay on screen.
    files: isFilesUnavailableError(error) ? [] : data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
