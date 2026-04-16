"use client";

import useSWR, { mutate } from "swr";
import {
  fetchNetworkStatus,
  fetchConnectedDevices,
  fetchFirewallConfig,
  confirmNetworkCommand,
  RouterStatusError,
  type RouterErrorCode,
} from "../api";
import type {
  NetworkOverview,
  ConnectedDevice,
  FirewallConfig,
  NetworkCommandResult,
} from "../types";

const STATUS_KEY = "/api/network/status";
const DEVICES_KEY = "/api/network/devices";
const FIREWALL_KEY = "/api/network/firewall";

export function useNetwork() {
  const {
    data: overview,
    error: statusError,
    isLoading: statusLoading,
    isValidating: statusValidating,
    mutate: mutateStatus,
  } = useSWR<NetworkOverview>(STATUS_KEY, fetchNetworkStatus, {
    refreshInterval: 10_000,
  });

  const {
    data: devices,
    error: devicesError,
    isLoading: devicesLoading,
    mutate: mutateDevices,
  } = useSWR<ConnectedDevice[]>(DEVICES_KEY, fetchConnectedDevices, {
    refreshInterval: 15_000,
  });

  const {
    data: firewall,
    mutate: mutateFirewall,
  } = useSWR<FirewallConfig>(FIREWALL_KEY, fetchFirewallConfig, {
    refreshInterval: 30_000,
  });

  async function confirm(token: string, operation: string, entityId?: string) {
    // WARP-41: callers must echo the original operation so the orchestrator
    // can reject a token issued for a different pending op.
    await confirmNetworkCommand(token, operation, entityId);
    refreshAll();
  }

  function refreshAll() {
    mutateStatus();
    mutateDevices();
    mutateFirewall();
  }

  // WARP-39: derive a typed error code from whatever SWR surfaced so the UI
  // can render per-cause messaging ("Router slow to respond" vs "Credentials
  // rejected — re-run setup") instead of a single "Router Not Connected" state.
  const routerErrorCode: RouterErrorCode | null =
    statusError instanceof RouterStatusError ? statusError.code : null;

  return {
    overview,
    devices: devices ?? [],
    firewall,
    isLoading: statusLoading || devicesLoading,
    isRefreshing: statusValidating,
    error: statusError || devicesError,
    routerErrorCode,
    routerErrorMessage:
      statusError instanceof RouterStatusError ? statusError.message : null,
    routerConnected: overview?.routerConnected ?? false,
    confirm,
    refresh: refreshAll,
  };
}
