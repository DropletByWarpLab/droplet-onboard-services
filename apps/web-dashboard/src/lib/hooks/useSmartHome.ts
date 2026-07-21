"use client";

import useSWR, { mutate } from "swr";
import {
  fetchMatterDevices,
  sendMatterCommand,
  discoverMatterDevices,
  commissionMatterDevice,
  decommissionMatterDevice,
  reconnectMatterDevice,
} from "../api";
import type {
  MatterGrouped,
  MatterDiscoveredDevice,
  MatterCommandResult,
} from "../types";

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

  /**
   * KAN-5: issue a device command and return a discriminated result so callers
   * can detect the Tier-2 `confirmation_required` path instead of swallowing it.
   *
   * The orchestrator answers a Tier-2 write (lock/unlock, climate setpoint
   * >= 30C) with HTTP 202 `{ status: "confirmation_required", confirmationToken,
   * service, … }`. We surface that body verbatim (typed) so the caller can show
   * a confirm affordance and complete via `confirmMatterCommand`. A Tier-1 write
   * executes immediately and we revalidate the device list; the caller gets
   * `{ status: "ok" }`.
   */
  async function command(
    nodeId: string,
    cmd: string,
    data?: Record<string, unknown>
  ): Promise<MatterCommandResult> {
    const body = (await sendMatterCommand(nodeId, cmd, data)) as
      | { status?: string }
      | null;

    if (body?.status === "confirmation_required") {
      const conf = body as {
        nodeId: string;
        confirmationToken: string;
        service: string;
        reason: string;
        tier: number;
      };
      // Tier-2 — nothing executed yet, so don't revalidate here; the caller
      // refreshes after a successful confirm.
      return {
        status: "confirmation_required",
        nodeId: conf.nodeId,
        confirmationToken: conf.confirmationToken,
        service: conf.service,
        reason: conf.reason,
        tier: conf.tier,
      };
    }

    // Tier-1 — executed; revalidate the device list to reflect new state.
    mutate(DEVICES_KEY);
    return { status: "ok" };
  }

  async function commission(pairingCode: string) {
    const result = await commissionMatterDevice(pairingCode);
    mutate(DEVICES_KEY);
    mutate(DISCOVERED_KEY);
    return result;
  }

  // WARP-1469: unpair a device from the Droplet. The backend force-removes
  // from the local fabric even when the device is offline, so an orphaned
  // entry can always be cleared. Revalidate so it drops out of the list.
  async function remove(nodeId: string) {
    await decommissionMatterDevice(nodeId);
    mutate(DEVICES_KEY);
  }

  // WARP-1469: nudge an offline device to reconnect now. The device list
  // reflects the new connectionState via the SSE bridge + the 4s poll, so
  // we revalidate immediately and let those carry the eventual outcome.
  async function reconnect(nodeId: string) {
    const result = await reconnectMatterDevice(nodeId);
    mutate(DEVICES_KEY);
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
    remove,
    reconnect,
    refresh,
  };
}
