"use client";

import useSWR from "swr";
import { fetchConnectorDirectory, type ConnectorDirectoryEntry } from "@/lib/api";

export const CONNECTOR_DIRECTORY_KEY = "/api/connectors/directory";

/**
 * WARP-3965 — the Connectors directory. `enabled: false` skips the read (a guest
 * has no directory and must not cause a request). One failed read stands until
 * the person retries: an empty directory would pass for "nothing exists".
 */
export function useConnectorDirectory(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<ConnectorDirectoryEntry[]>(
    enabled ? CONNECTOR_DIRECTORY_KEY : null,
    fetchConnectorDirectory,
    { shouldRetryOnError: false, revalidateOnFocus: true },
  );
  return {
    entries: data,
    loading: isLoading,
    /** `directory_absent` on a box that predates the directory; otherwise a short code. */
    error: error instanceof Error ? error.message : error ? "directory_failed" : null,
    refresh: () => mutate(),
  };
}
