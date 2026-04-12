"use client";

import useSWR from "swr";
import {
  fetchCameras,
  fetchDiscoveredCameras,
  fetchCameraEvents,
  acceptDiscoveredCamera,
  rejectDiscoveredCamera,
  enableCamera,
  disableCamera,
  removeCamera,
} from "@/lib/api";
import type { CameraInfo, DetectionEvent, DiscoveredCamera } from "@/lib/types";

const CAMERAS_KEY = "/api/cameras";
const DISCOVERED_KEY = "/api/cameras/discovered";
const EVENTS_KEY = "/api/cameras/events/recent";

export function useCameras() {
  const {
    data: cameras,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<CameraInfo[]>(CAMERAS_KEY, fetchCameras, {
    refreshInterval: 10_000,
  });

  const { data: discovered, mutate: mutateDiscovered } = useSWR<DiscoveredCamera[]>(
    DISCOVERED_KEY,
    fetchDiscoveredCameras,
    { refreshInterval: 30_000 }
  );

  const { data: recentEvents } = useSWR<DetectionEvent[]>(
    EVENTS_KEY,
    () => fetchCameraEvents(10),
    { refreshInterval: 10_000 }
  );

  return {
    cameras: cameras ?? [],
    discovered: discovered ?? [],
    recentEvents: recentEvents ?? [],
    totalCameras: cameras?.length ?? 0,
    isLoading,
    isRefreshing: isValidating,
    error,
    refresh: () => {
      mutate();
      mutateDiscovered();
    },
    acceptCamera: async (id: string) => {
      await acceptDiscoveredCamera(id);
      mutateDiscovered();
      mutate();
    },
    rejectCamera: async (id: string) => {
      await rejectDiscoveredCamera(id);
      mutateDiscovered();
    },
    enableCam: async (name: string) => {
      await enableCamera(name);
      mutate();
    },
    disableCam: async (name: string) => {
      await disableCamera(name);
      mutate();
    },
    removeCam: async (name: string) => {
      await removeCamera(name);
      mutate();
    },
  };
}
