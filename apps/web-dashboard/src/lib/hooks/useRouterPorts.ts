"use client";

import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import type { RouterPortMap } from "@/lib/types/router-ports";

/**
 * useRouterPorts — binds the router port panel to GET /api/network/ports
 * (WARP-1866).
 *
 * Read-only, so this is a much smaller hook than `useSwitch`: no Tier-2
 * confirm choreography, no write actions, no post-write refresh. There is no
 * write path to the router's jacks by design — see the route comment in
 * apps/orchestrator/src/routes/network-status.routes.ts.
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
}

export function useRouterPorts(): UseRouterPortsResult {
  const { data, isLoading, error, mutate } = useSWR<RouterPortMap>(
    "/api/network/ports",
    fetchRouterPorts,
    { refreshInterval: PORTS_REFRESH_MS },
  );

  return {
    map: data ?? null,
    isLoading,
    error: error as Error | undefined,
    refresh: () => void mutate(),
  };
}
