"use client";

import useSWR from "swr";
import { fetchModelsPage } from "../api";
import type { ModelsPagePayload } from "../types";

/**
 * WARP-836 — the read-only Models surface (`/models`).
 *
 * Mirrors `useModels` but hits `GET /api/models` (the page payload) rather
 * than `/api/llm/models` (the chat selector). Polls every 30s — model
 * lifecycle + KPIs drift slowly, and the page is purely informational, so we
 * don't hammer the orchestrator. A failed fetch surfaces on `error`; the page
 * renders its degraded state from there. An empty `local` list (ai-gateway
 * down) is a valid payload, not an error.
 */
export function useModelsPage() {
  const { data, error, isLoading, mutate } = useSWR<ModelsPagePayload>(
    "/api/models",
    fetchModelsPage,
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
