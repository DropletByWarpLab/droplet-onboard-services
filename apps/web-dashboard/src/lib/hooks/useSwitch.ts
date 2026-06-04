"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import {
  switchSetPortVlan,
  switchSetPortPoe,
  switchSetPortEnabled,
  switchProvision,
  confirmNetworkCommand,
} from "@/lib/api";
import type {
  SwitchStatus,
  SwitchPort,
  SwitchVlan,
} from "@/lib/types/switch";
import type { NetworkCommandResult } from "@/lib/types";

/**
 * useSwitch — binds the managed-switch panel to the §7 contract
 * (reference/ADDON-network-switch-management.md §7).
 *
 * Reads (SWR + authFetch):
 *   - GET /api/switch/status  — ~30s (slow-moving fabric state).
 *   - GET /api/switch/ports   — ~10s (link/PoE flap faster).
 *   - GET /api/switch/vlans   — ~30s.
 *
 * Writes (owner/admin, Tier-2 confirm-gated, Activity-logged server-side):
 * each POST returns a 202 confirm token, then we echo it back through
 * `confirmNetworkCommand` — the same dance the router writes use. The caller
 * (SwitchPanel) shows the <ConfirmDialog> blast-radius copy between the two
 * calls; this hook owns the actual two-step network choreography.
 */

const PORTS_REFRESH_MS = 10_000;
const STATUS_REFRESH_MS = 30_000;

async function fetchStatus(url: string): Promise<SwitchStatus> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Switch status: ${res.status}`);
  return res.json();
}

async function fetchPorts(url: string): Promise<SwitchPort[]> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Switch ports: ${res.status}`);
  return res.json();
}

async function fetchVlans(url: string): Promise<SwitchVlan[]> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Switch VLANs: ${res.status}`);
  return res.json();
}

export interface UseSwitchResult {
  status: SwitchStatus | null;
  ports: SwitchPort[];
  vlans: SwitchVlan[];
  isLoading: boolean;
  error: Error | undefined;
  /** Derived from status.connected — drives the calm empty state. */
  connected: boolean;
  refresh: () => void;
  // Tier-2 writes. Each resolves once the confirm round-trip completes (or
  // immediately if the server didn't request confirmation).
  changeVlan: (port: number, vlanId: number) => Promise<void>;
  togglePoe: (port: number, enabled: boolean) => Promise<void>;
  setPortEnabled: (port: number, enabled: boolean) => Promise<void>;
  reapplyConfig: () => Promise<void>;
}

export function useSwitch(): UseSwitchResult {
  const statusSwr = useSWR<SwitchStatus>("/api/switch/status", fetchStatus, {
    refreshInterval: STATUS_REFRESH_MS,
  });
  const portsSwr = useSWR<SwitchPort[]>("/api/switch/ports", fetchPorts, {
    refreshInterval: PORTS_REFRESH_MS,
  });
  const vlansSwr = useSWR<SwitchVlan[]>("/api/switch/vlans", fetchVlans, {
    refreshInterval: STATUS_REFRESH_MS,
  });

  const refresh = useCallback(() => {
    void statusSwr.mutate();
    void portsSwr.mutate();
    void vlansSwr.mutate();
  }, [statusSwr, portsSwr, vlansSwr]);

  // The shared Tier-2 dance: POST → if the server issued a confirm token,
  // echo it back through the canonical confirm endpoint. Re-fetch after a
  // confirmed write so the panel reflects the new state without a manual
  // refresh. `mutate` lives on the SWR handles; capture them in the closure.
  const runWrite = useCallback(
    async (result: NetworkCommandResult) => {
      if (result.requiresConfirmation && result.confirmationToken && result.operation) {
        await confirmNetworkCommand(result.confirmationToken, result.operation);
        refresh();
      }
    },
    [refresh],
  );

  const changeVlan = useCallback(
    async (port: number, vlanId: number) => {
      await runWrite(await switchSetPortVlan(port, vlanId));
    },
    [runWrite],
  );

  const togglePoe = useCallback(
    async (port: number, enabled: boolean) => {
      await runWrite(await switchSetPortPoe(port, enabled));
    },
    [runWrite],
  );

  const setPortEnabled = useCallback(
    async (port: number, enabled: boolean) => {
      await runWrite(await switchSetPortEnabled(port, enabled));
    },
    [runWrite],
  );

  const reapplyConfig = useCallback(async () => {
    await runWrite(await switchProvision());
  }, [runWrite]);

  const status = statusSwr.data ?? null;

  return {
    status,
    ports: portsSwr.data ?? [],
    vlans: vlansSwr.data ?? [],
    // Loading is gated on status — it's the field every render path keys off.
    isLoading: statusSwr.isLoading,
    error: statusSwr.error as Error | undefined,
    // A failed/absent status read reads as "not connected" so the panel never
    // implies a live switch it can't actually see.
    connected: status?.connected === true,
    refresh,
    changeVlan,
    togglePoe,
    setPortEnabled,
    reapplyConfig,
  };
}
