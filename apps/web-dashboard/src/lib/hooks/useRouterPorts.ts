"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import { routerSetPortEnabled, confirmNetworkCommand } from "@/lib/api";
import type { RouterPortMap } from "@/lib/types/router-ports";

/**
 * useRouterPorts — binds the router port panel to GET /api/network/ports
 * (WARP-1866) and, since WARP-1907, to the jack enable/disable write.
 *
 * The write runs the same two-step Tier-2 dance `useSwitch` does: the POST
 * answers 202 with a confirmation token, and we echo it back through the
 * canonical confirm endpoint. The blast-radius dialog the user sees happens
 * between the caller's click and this call — `RouterPortsPanel` owns the copy,
 * this hook owns the choreography and the post-write refresh.
 *
 * Unlike the switch's per-port writes, these apply through the routing
 * service's `safe_apply`, so a change that severs the appliance's own path to
 * the router self-reverts after 60s. Nothing here polls for that: the map
 * refreshes on its own interval and a reverted jack simply reappears.
 *
 * Refresh matches the switch port map (10s). Someone plugging a cable in and
 * watching the panel is the whole use case, and the two panels sit one above
 * the other — a slower interval here would show the same cable arriving at the
 * switch before it arrives at the router.
 */
const PORTS_REFRESH_MS = 10_000;

async function fetchRouterPorts(url: string): Promise<RouterPortMap> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Router ports: ${res.status}`);
  return res.json();
}

export interface UseRouterPortsResult {
  map: RouterPortMap | null;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => void;
  /**
   * Turn a jack on or off. `force` is the user's second acknowledgement and is
   * passed straight through — never defaulted to true, because it is the only
   * thing standing between a click and cutting the household's internet.
   */
  setPortEnabled: (port: string, enabled: boolean, force?: boolean) => Promise<void>;
}

export function useRouterPorts(): UseRouterPortsResult {
  const { data, isLoading, error, mutate } = useSWR<RouterPortMap>(
    "/api/network/ports",
    fetchRouterPorts,
    { refreshInterval: PORTS_REFRESH_MS },
  );

  const setPortEnabled = useCallback(
    async (port: string, enabled: boolean, force = false) => {
      const result = await routerSetPortEnabled(port, enabled, force);
      if (result.requiresConfirmation && result.confirmationToken && result.operation) {
        await confirmNetworkCommand(result.confirmationToken, result.operation);
      }
      // Re-read after ANY successful write. netifd needs a moment to tear the
      // link down, so this first read may still show the old state — the 10s
      // interval catches up. Better a map that lags by one tick than an
      // optimistic flip that would be a lie if the write is rolling back.
      void mutate();
    },
    [mutate],
  );

  return {
    map: data ?? null,
    isLoading,
    error: error as Error | undefined,
    refresh: () => void mutate(),
    setPortEnabled,
  };
}
