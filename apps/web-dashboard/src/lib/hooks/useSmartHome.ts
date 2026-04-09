"use client";

import useSWR, { mutate } from "swr";
import {
  fetchMatterDevices,
  sendMatterCommand,
  discoverMatterDevices,
  commissionMatterDevice,
} from "../api";
import type { MatterGrouped, MatterDiscoveredDevice } from "../types";

const DEVICES_KEY = "/api/matter/devices";
const DISCOVERED_KEY = "/api/matter/discover";

export function useSmartHome() {
  const {
    data: grouped,
    error,
    isLoading,
    isValidating,
    mutate: mutateDevices,
  } = useSWR<MatterGrouped>(DEVICES_KEY, fetchMatterDevices, {
    refreshInterval: 4000,
  });

  const { data: discoveryResult } = useSWR<{
    devices: MatterDiscoveredDevice[];
    count: number;
  }>(DISCOVERED_KEY, discoverMatterDevices, {
    refreshInterval: 30000,
    // Discovery takes ~15s, don't error on slow requests
    errorRetryCount: 1,
  });

  const discovered = discoveryResult?.devices ?? [];

  async function command(
    nodeId: string,
    cmd: string,
    data?: Record<string, unknown>
  ) {
    await sendMatterCommand(nodeId, cmd, data);
    mutate(DEVICES_KEY);
  }

  async function commission(pairingCode: string) {
    const result = await commissionMatterDevice(pairingCode);
    mutate(DEVICES_KEY);
    mutate(DISCOVERED_KEY);
    return result;
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
    discovered,
    totalDevices,
    isLoading,
    isRefreshing: isValidating,
    error,
    command,
    commission,
    refresh,
  };
}
