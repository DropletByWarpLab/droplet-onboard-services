"use client";

import useSWR from "swr";
import {
  fetchSceneSchedules,
  createSceneSchedule,
  toggleSceneSchedule,
  deleteSceneSchedule,
  type SceneSchedule,
} from "../api";

/**
 * Schedules for one routine (Scene, feat/scene-schedules). Sibling of
 * useScenes — the editor lists/creates/toggles/removes the recurring
 * cadences an owner has armed for a routine. Only fetches when a sceneId
 * is provided (the SWR key is null otherwise, so the hook is inert until
 * the schedule panel opens for a specific routine). The mutators
 * revalidate the list so the panel reflects a change immediately.
 */
export function useSceneSchedules(sceneId: string | null) {
  const key = sceneId ? `/api/scenes/${sceneId}/schedules` : null;
  const { data, error, isLoading, mutate } = useSWR<SceneSchedule[]>(
    key,
    () => fetchSceneSchedules(sceneId as string),
    { errorRetryCount: 1 },
  );

  return {
    schedules: data ?? [],
    isLoading,
    error,
    refresh: () => mutate(),
    create: async (rrule: string, timezone?: string) => {
      const schedule = await createSceneSchedule(
        sceneId as string,
        rrule,
        timezone,
      );
      await mutate();
      return schedule;
    },
    toggle: async (scheduleId: string, enabled: boolean) => {
      const schedule = await toggleSceneSchedule(
        sceneId as string,
        scheduleId,
        enabled,
      );
      await mutate();
      return schedule;
    },
    remove: async (scheduleId: string) => {
      await deleteSceneSchedule(sceneId as string, scheduleId);
      await mutate();
    },
  };
}
