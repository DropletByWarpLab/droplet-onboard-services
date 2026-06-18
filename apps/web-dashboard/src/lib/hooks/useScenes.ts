"use client";

import useSWR from "swr";
import { fetchScenes, type Scene } from "../api";

const SCENES_KEY = "/api/scenes";

/**
 * Saved routines (scenes, WARP-474). Backs the smart-home KPI strip's routine
 * count and the Routines section. Polls lazily — routines change rarely, so a
 * 30s interval keeps the count fresh without hammering the orchestrator.
 */
export function useScenes() {
  const { data, error, isLoading, mutate } = useSWR<Scene[]>(
    SCENES_KEY,
    fetchScenes,
    { refreshInterval: 30000, errorRetryCount: 1 },
  );

  return {
    scenes: data ?? [],
    isLoading,
    error,
    refresh: () => mutate(),
  };
}
