"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { HeartPulse } from "lucide-react";
import { fetchSystemHealth, fetchSystemHealthDetails, type SystemHealth } from "@/lib/api";
import { HealthStatusView } from "@/components/health/HealthStatusView";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";

/**
 * /health — appliance/service health status page (PR #382).
 *
 * Reads the EXISTING WARP-43 rolled-up aggregate (`GET
 * /api/orchestrator/health` via `fetchSystemHealth`) — the same cached
 * snapshot the home-page pill and the Docker healthcheck consume, refreshed
 * by the orchestrator's background health-monitor every 15s. We poll on the
 * same 15s cadence so the page stays live without hammering the endpoint, and
 * render the pure `HealthStatusView`. No new data source.
 *
 * WARP-3154 — the public route above never carries a down component's
 * `error` (it's unauthenticated and can't tell an owner from an anonymous
 * LAN client). Owner/admin also poll the authenticated
 * `/api/orchestrator/health/details` counterpart and the reason text is
 * merged in here, client-side, before rendering — everyone else sees only
 * the public snapshot.
 */
export default function HealthPage() {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const { data, error, isLoading } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );
  const { data: details } = useSWR<SystemHealth>(
    isAdmin ? "/api/orchestrator/health/details" : null,
    fetchSystemHealthDetails,
    { refreshInterval: 15_000 },
  );

  const merged = useMemo<SystemHealth | undefined>(() => {
    if (!data) return data;
    if (!details) return data;
    const reasonByName = new Map(details.components.map((c) => [c.name, c.error]));
    return {
      ...data,
      components: data.components.map((c) => ({ ...c, error: reasonByName.get(c.name) })),
    };
  }, [data, details]);

  return (
    <ShellPage icon={<HeartPulse size={15} />} label="Health">
      <HealthStatusView
        health={merged}
        isLoading={isLoading}
        error={error instanceof Error ? error : undefined}
      />
    </ShellPage>
  );
}
