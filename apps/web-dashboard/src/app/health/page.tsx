"use client";

import useSWR from "swr";
import { fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { HealthStatusView } from "@/components/health/HealthStatusView";

/**
 * /health — appliance/service health status page (PR #382).
 *
 * Reads the EXISTING WARP-43 rolled-up aggregate (`GET
 * /api/orchestrator/health` via `fetchSystemHealth`) — the same cached
 * snapshot the home-page pill and the Docker healthcheck consume, refreshed
 * by the orchestrator's background health-monitor every 15s. We poll on the
 * same 15s cadence so the page stays live without hammering the endpoint, and
 * render the pure `HealthStatusView`. No new data source.
 */
export default function HealthPage() {
  const { data, error, isLoading } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );

  return (
    <HealthStatusView
      health={data}
      isLoading={isLoading}
      error={error instanceof Error ? error : undefined}
    />
  );
}
