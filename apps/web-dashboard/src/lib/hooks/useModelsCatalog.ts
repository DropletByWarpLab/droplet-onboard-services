"use client";

import useSWR from "swr";
import { fetchModelsCatalog } from "../api";
import type { ModelsCatalogPayload } from "../types";

/**
 * WARP-1827 — the eligible model catalog (`GET /api/models/catalog`).
 *
 * Mirrors `useModelsPage`'s fetch/error/refresh shape. The catalog itself
 * drifts slowly (it changes when the sidecar's list or the box's VRAM story
 * does), but the per-model `pulled` flags flip when a download finishes —
 * the pull flow calls `refresh` explicitly on success, and the 30s poll
 * keeps a second browser tab honest. A failed fetch surfaces on `error`;
 * the page treats the section as an enhancement and renders nothing rather
 * than an error wall (the Models page's own degraded state already tells
 * the AI-service-down story).
 */
export function useModelsCatalog() {
  const { data, error, isLoading, mutate } = useSWR<ModelsCatalogPayload>(
    "/api/models/catalog",
    fetchModelsCatalog,
    {
      refreshInterval: 30000,
      revalidateOnFocus: false,
    },
  );

  return {
    data,
    error: error as Error | undefined,
    isLoading,
    refresh: mutate,
  };
}
