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
    error,
    isLoading,
    refresh: mutate,
  };
}
