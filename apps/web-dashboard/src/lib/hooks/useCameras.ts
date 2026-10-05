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
import { isServiceDegraded } from "@/lib/camera-recording";
import type {
  CameraCandidateList,
  CameraInfo,
  DetectionEvent,
} from "@/lib/types";

const CAMERAS_KEY = "/api/cameras";
const DISCOVERED_KEY = "/api/cameras/discovered";
const EVENTS_KEY = "/api/cameras/events/recent";

/**
 * `enabled: false` pauses every camera poll (null SWR keys). Every camera
 * route refuses role `guest` and each 403 writes an audited "Access denied"
 * row, so a caller that can't view cameras must not poll them (WARP-3157).
 */
export function useCameras({ enabled = true }: { enabled?: boolean } = {}) {
  const {
    data: cameras,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<CameraInfo[]>(enabled ? CAMERAS_KEY : null, fetchCameras, {
    refreshInterval: 10_000,
  });

  // WARP-1847: the candidate envelope, not a bare array — `discoveryOnline`
  // is what lets the page distinguish "nothing on your network" from
  // "nothing is scanning".
  const { data: discovery, mutate: mutateDiscovered } = useSWR<CameraCandidateList>(
    enabled ? DISCOVERED_KEY : null,
    fetchCameraCandidates,
    { refreshInterval: 30_000 },
  );

  const { data: recentEvents } = useSWR<DetectionEvent[]>(
    enabled ? EVENTS_KEY : null,
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
    // WARP-3511: the camera service could not be read (restarting after a
    // settings save, or down). Every tile's status is unknown, which is not
    // the same as every camera being offline.
    serviceDegraded: isServiceDegraded(cameras ?? []),
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
