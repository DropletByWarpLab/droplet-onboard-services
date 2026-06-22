"use client";

import useSWR from "swr";
import { fetchSpaces } from "../api";
import type { FileSpacesResponse } from "../types";

/**
 * WARP-883 (ADR-027 WS-5) — which Files spaces exist for the current user.
 *
 * Drives the My Files / Shared switcher: the switcher only appears when the
 * shared "Household" space is available. Defaults to shared-unavailable until
 * the probe resolves so the UI never flashes a switcher that then vanishes.
 */
export function useSpaces() {
  const { data, error, isLoading } = useSWR<FileSpacesResponse>(
    "/api/files/spaces",
    () => fetchSpaces(),
    { revalidateOnFocus: false }
  );

  return {
    spaces: data?.spaces ?? [],
    sharedAvailable: data?.sharedAvailable ?? false,
    error,
    isLoading,
  };
}
