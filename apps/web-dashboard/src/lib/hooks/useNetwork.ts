"use client";

import useSWR, { mutate } from "swr";
import {
  fetchNetworkStatus,
  fetchConnectedDevices,
  fetchFirewallConfig,
  confirmNetworkCommand,
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

  async function confirm(token: string) {
    await confirmNetworkCommand(token);
    refreshAll();
  }

  function refreshAll() {
    mutateStatus();
    mutateDevices();
    mutateFirewall();
  }

  return {
    overview,
    devices: devices ?? [],
    firewall,
    isLoading: statusLoading || devicesLoading,
    isRefreshing: statusValidating,
    error: statusError || devicesError,
    routerConnected: overview?.routerConnected ?? false,
    confirm,
    refresh: refreshAll,
  };
}
