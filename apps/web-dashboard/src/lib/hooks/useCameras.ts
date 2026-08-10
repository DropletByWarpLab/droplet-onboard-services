"use client";

import useSWR from "swr";
import {
  fetchCameras,
  fetchCameraCandidates,
  fetchCameraEvents,
  acceptDiscoveredCamera,
  rejectDiscoveredCamera,
  enableCamera,
  disableCamera,
  removeCamera,
} from "@/lib/api";
import type {
  CameraCandidateList,
  CameraInfo,
  DetectionEvent,
} from "@/lib/types";

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

  // WARP-1847: the candidate envelope, not a bare array — `discoveryOnline`
  // is what lets the page distinguish "nothing on your network" from
  // "nothing is scanning".
  const { data: discovery, mutate: mutateDiscovered } = useSWR<CameraCandidateList>(
    DISCOVERED_KEY,
    fetchCameraCandidates,
    { refreshInterval: 30_000 },
  );

  const { data: recentEvents } = useSWR<DetectionEvent[]>(
    EVENTS_KEY,
    () => fetchCameraEvents(10),
    { refreshInterval: 10_000 }
  );

  return {
    cameras: cameras ?? [],
    discovered: discovery?.cameras ?? [],
    // Optimistic until the first poll lands, so a loading page doesn't flash
    // "discovery isn't running".
    discoveryOnline: discovery?.discoveryOnline ?? true,
    recentEvents: recentEvents ?? [],
    totalCameras: cameras?.length ?? 0,
    isLoading,
    isRefreshing: isValidating,
    error,
    refresh: () => {
      mutate();
      mutateDiscovered();
    },
    /** Seed the candidate cache from a scan response instead of waiting on the poll. */
    setDiscovered: (list: CameraCandidateList) => {
      mutateDiscovered(list, { revalidate: false });
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
