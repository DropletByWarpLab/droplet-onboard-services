"use client";

import useSWR from "swr";
import { fetchIntegrations } from "../api.erp";
import { CONNECTORS } from "../connectors";
import type { ConnectorMeta, IntegrationConnection, IntegrationStatus } from "../erp-types";

export interface HubEntry {
  meta: ConnectorMeta;
  connection: IntegrationConnection;
}

/** Statuses that count as "connected" for the hub's Connected strip. */
const LIVE_STATUSES: IntegrationStatus[] = ["CONNECTED", "DEGRADED", "DRIFT_LOCKED"];

/**
 * The Integrations hub model. Merges the static connector catalog with live
 * connection status from GET /api/integrations. When the backend isn't wired
 * yet (404), every available connector simply shows as not-connected — the
 * honest first-run state, no error surfaced to the user.
 */
export function useIntegrations() {
  const { data, error, isLoading, mutate } = useSWR<IntegrationConnection[]>(
    "/api/integrations",
    fetchIntegrations,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );

  const byId = new Map<string, IntegrationConnection>(
    (data ?? []).map((c) => [c.provider, c]),
  );

  const entries: HubEntry[] = CONNECTORS.map((meta) => ({
    meta,
    connection:
      byId.get(meta.id) ??
      { provider: meta.id, status: "NOT_CONFIGURED", writeEnabled: false },
  }));

  const connected = entries.filter((e) =>
    LIVE_STATUSES.includes(e.connection.status),
  );

  return {
    entries,
    connected,
    hasBackend: !error,
    isLoading,
    refresh: () => mutate(),
  };
}
