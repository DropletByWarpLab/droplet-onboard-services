"use client";

import useSWR from "swr";
import { fetchCameraBusinessHours, saveCameraBusinessHours } from "@/lib/api";
import type { CameraBusinessHours } from "@/lib/types";

export function useCameraBusinessHours() {
  const { data, error, isLoading, mutate } = useSWR(
    "/api/cameras/business-hours",
    fetchCameraBusinessHours,
    { refreshInterval: 60_000 },
  );
  return {
    schedule: data,
    error,
    isLoading,
    retry: () => mutate(),
    save: async (schedule: CameraBusinessHours) => {
      const saved = await saveCameraBusinessHours(schedule);
      await mutate(saved, { revalidate: false });
    },
  };
}
