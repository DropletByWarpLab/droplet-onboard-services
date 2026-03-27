"use client";

import useSWR from "swr";
import { fetchDevices, fetchHealth } from "../api";
import type { DeviceInfo, HealthResponse } from "../types";

export function useDevice() {
  const { data: devices, error: devicesError } = useSWR<DeviceInfo[]>(
    "/api/devices",
    fetchDevices,
    { refreshInterval: 10000 }
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
