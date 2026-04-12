"use client";

import useSWR from "swr";
import { fetchDeviceClients } from "../api";
import type { DeviceClientInfo } from "../types";

export function useDeviceClients() {
  const { data, error, isLoading, mutate } = useSWR<DeviceClientInfo[]>(
    "/api/devices/clients",
    () => fetchDeviceClients(),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );

  return {
    items: data ?? [],
    error,
    isLoading,
    refresh: mutate,
  };
}
