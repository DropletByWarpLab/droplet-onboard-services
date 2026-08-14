"use client";

import { useCallback, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
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

/**
 * WARP-1713: the key prefixes the Network tab owns.
 *
 * Refresh used to revalidate exactly the three keys this hook subscribes to,
 * but almost nothing the operator is LOOKING AT lives on those keys — the
 * coverage APs, interfaces, radio detail, guest Wi-Fi, DHCP pool, UPnP, system
 * controls, phone-home, AI access, camera privacy and the whole switch panel
 * each own their own `useSWR` key. On Simple/Overview, WiFi, Devices or System
 * every visible card sat outside the refresh set, so the button spun and the
 * page didn't move. Refresh now sweeps the whole surface by key prefix, which
 * also means a card added later is covered without touching this list.
 */
const NETWORK_KEY_PREFIXES = ["/api/network", "/api/aps", "/api/switch"] as const;

/**
 * True for any SWR key belonging to the Network tab's surface.
 *
 * Matches on a path BOUNDARY, not a bare `startsWith` — a raw prefix test also
 * claims unrelated routes that merely begin with the same letters
 * (`/api/networking-*`), and silently revalidating another page's keys is the
 * kind of thing nobody notices until it costs a request storm.
 */
export function isNetworkSurfaceKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return NETWORK_KEY_PREFIXES.some(
    (prefix) =>
      key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`),
  );
}

export function useNetwork() {
  const { mutate } = useSWRConfig();
  // The sweep is a multi-key revalidation, so the status key's own
  // `isValidating` goes false long before the page has finished catching up.
  // Track the sweep itself so the spinner tells the truth.
  const [sweeping, setSweeping] = useState(false);

  const {
    data: overview,
    error: statusError,
    isLoading: statusLoading,
    isValidating: statusValidating,
  } = useSWR<NetworkOverview>(STATUS_KEY, fetchNetworkStatus, {
    refreshInterval: 10_000,
  });

  const {
    data: devices,
    error: devicesError,
    isLoading: devicesLoading,
  } = useSWR<ConnectedDevice[]>(DEVICES_KEY, fetchConnectedDevices, {
    refreshInterval: 15_000,
  });

  const { data: firewall } = useSWR<FirewallConfig>(FIREWALL_KEY, fetchFirewallConfig, {
    refreshInterval: 30_000,
  });

  // Stable identity: the page holds `refresh` in the dep array of its
  // operation-polling effect, so a fresh function every render tore down and
  // rebuilt that 1s interval on every render while a write was in flight.
  const refreshAll = useCallback(async () => {
    setSweeping(true);
    try {
      await mutate(isNetworkSurfaceKey);
    } finally {
      setSweeping(false);
    }
  }, [mutate]);

  const confirm = useCallback(
    async (token: string, operation: string, entityId?: string) => {
      // WARP-41: callers must echo the original operation so the orchestrator
      // can reject a token issued for a different pending op.
      await confirmNetworkCommand(token, operation, entityId);
      await refreshAll();
    },
    [refreshAll],
  );

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
    isRefreshing: statusValidating || sweeping,
    error: statusError || devicesError,
    routerErrorCode,
    routerErrorMessage:
      statusError instanceof RouterStatusError ? statusError.message : null,
    routerConnected: overview?.routerConnected ?? false,
    confirm,
    refresh: refreshAll,
  };
}
