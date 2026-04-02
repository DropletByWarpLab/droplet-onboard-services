"use client";

import useSWR, { mutate } from "swr";
import {
  fetchSmartHomeDevices,
  sendSmartHomeCommand,
  fetchDiscoveredDevices,
  acceptDiscoveredDevice,
} from "../api";
import type { SmartHomeGrouped, DiscoveredDevice } from "../types";

const DEVICES_KEY = "/api/devices/smart-home";
const DISCOVERED_KEY = "/api/devices/smart-home/discovered";

export function useSmartHome() {
  const {
    data: grouped,
    error,
    isLoading,
    isValidating,
    mutate: mutateDevices,
  } = useSWR<SmartHomeGrouped>(DEVICES_KEY, fetchSmartHomeDevices, {
    refreshInterval: 4000,
  });

  const { data: discovered } = useSWR<DiscoveredDevice[]>(
    DISCOVERED_KEY,
    fetchDiscoveredDevices,
    { refreshInterval: 15000 }
  );

  async function command(
    entityId: string,
    service: string,
    data?: Record<string, unknown>
  ) {
    await sendSmartHomeCommand(entityId, service, data);
    mutate(DEVICES_KEY);
  }

  async function accept(flowId: string) {
    await acceptDiscoveredDevice(flowId);
    mutate(DEVICES_KEY);
    mutate(DISCOVERED_KEY);
  }

  const totalDevices = grouped
    ? Object.values(grouped).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0
      )
    : 0;

  function refresh() {
    mutateDevices();
    mutate(DISCOVERED_KEY);
  }

  return {
    grouped: grouped ?? null,
    discovered: discovered ?? [],
    totalDevices,
    isLoading,
    isRefreshing: isValidating,
    error,
    command,
    accept,
    refresh,
  };
}
