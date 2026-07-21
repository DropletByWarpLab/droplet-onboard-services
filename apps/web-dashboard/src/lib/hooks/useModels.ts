"use client";

import useSWR from "swr";
import { fetchModels } from "../api";
import type { ModelsResponse } from "../types";

export function useModels() {
  const { data, error, isLoading, mutate } = useSWR<ModelsResponse>(
    "/api/llm/models",
    fetchModels,
    {
      refreshInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  return {
    models: data?.models ?? [],
    // WARP-1112 — the box's active local model (set from /models). The chat
    // page defaults its picker to this instead of "the first model listed".
    defaultModel: data?.defaultModel ?? null,
    error,
    isLoading,
    refresh: mutate,
  };
}
