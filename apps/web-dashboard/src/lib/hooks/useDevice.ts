"use client";

import useSWR from "swr";
import { fetchDevices, fetchHealth } from "../api";
import type { DeviceInfo, HealthResponse } from "../types";

export function useDevice() {
  const { data: devices, error: devicesError } = useSWR<DeviceInfo[]>(
    "/api/devices",
    fetchDevices,
    // An empty answer means the box refused this role (WARP-3378, an external
    // guest): stop polling it rather than ask again every 10 s.
    { refreshInterval: (latest) => (latest && latest.length === 0 ? 0 : 10000) }
  );

  const { data: health, error: healthError } = useSWR<HealthResponse>(
    "/api/health",
    fetchHealth,
    { refreshInterval: 10000 }
  );

  return {
    device: devices?.[0] ?? null,
    devices: devices ?? [],
    health,
    isLoading: !devices && !devicesError,
    error: devicesError || healthError,
  };
}
