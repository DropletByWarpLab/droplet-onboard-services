"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import {
  addCameraPin,
  fetchCameraPins,
  removeCameraPin,
  reorderCameraPins,
} from "@/lib/api";
import type { CameraPinInfo } from "@/lib/types";

const KEY = "/api/cameras/pins";

/**
 * Per-user camera-pin state.
 *
 * Pins are an operator-local pref — they don't sync between users on
 * the same Droplet. This hook fetches the current user's pins and
 * exposes the three mutation paths (pin, unpin, reorder). Mutations
 * call the orchestrator and then revalidate SWR's cache so the
 * "Pinned" rail and the per-card star both rerender from the
 * authoritative server response.
 *
 * `pinnedSet` is a memoized lookup the CameraCard uses to flip the
 * star icon without scanning the array per render.
 *
 * Errors bubble out — the caller decides whether to alert/toast/log.
 */
export function useCameraPins() {
  const { data, error, isLoading, mutate } = useSWR<CameraPinInfo[]>(
    KEY,
    fetchCameraPins,
    { refreshInterval: 30_000 },
  );

  const pins = data ?? [];

  // O(1) "is camera N pinned?" lookup for the card star.
  const pinnedSet = useMemo(
    () => new Set(pins.map((p) => p.cameraName)),
    [pins],
  );

  const pin = useCallback(
    async (cameraName: string) => {
      const created = await addCameraPin(cameraName);
      await mutate();
      return created;
    },
    [mutate],
  );

  const unpin = useCallback(
    async (cameraName: string) => {
      await removeCameraPin(cameraName);
      await mutate();
    },
    [mutate],
  );

  /** Toggle helper — saves the caller from branching on isPinned. */
  const toggle = useCallback(
    async (cameraName: string) => {
      if (pinnedSet.has(cameraName)) {
        await unpin(cameraName);
      } else {
        await pin(cameraName);
      }
    },
    [pin, pinnedSet, unpin],
  );

  const reorder = useCallback(
    async (cameraNames: string[]) => {
      const next = await reorderCameraPins(cameraNames);
      await mutate(next, { revalidate: false });
      return next;
    },
    [mutate],
  );

  return {
    pins,
    pinnedSet,
    isLoading,
    error,
    refresh: () => mutate(),
    pin,
    unpin,
    toggle,
    reorder,
  };
}
