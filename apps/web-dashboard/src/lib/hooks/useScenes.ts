"use client";

import useSWR from "swr";
import {
  fetchScenes,
  createScene,
  updateScene,
  deleteScene,
  type Scene,
  type SceneActionInput,
} from "../api";

const SCENES_KEY = "/api/scenes";

/**
 * Saved routines (scenes, WARP-474). Backs the smart-home KPI strip's routine
 * count, the Routines list, and the authoring editor. Polls lazily — routines
 * change rarely, so a 30s interval keeps the count fresh without hammering the
 * orchestrator. The create/update/remove wrappers revalidate the list so the
 * KPI count + cards refresh immediately after an edit.
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
    create: async (body: { name: string; icon?: string | null; actions: SceneActionInput[] }) => {
      const scene = await createScene(body);
      await mutate();
      return scene;
    },
    update: async (
      id: string,
      patch: { name?: string; icon?: string | null; actions?: SceneActionInput[] },
    ) => {
      const scene = await updateScene(id, patch);
      await mutate();
      return scene;
    },
    remove: async (id: string) => {
      await deleteScene(id);
      await mutate();
    },
  };
}
