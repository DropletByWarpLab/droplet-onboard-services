"use client";

import useSWR from "swr";
import { fetchEaglesoft, fetchEaglesoftSchedule } from "../api.erp";
import { useAuth } from "../auth";
import type { EaglesoftDetail, ErpAccess, IntegrationConnection } from "../erp-types";

const DEFAULT_CONNECTION: IntegrationConnection = {
  provider: "eaglesoft",
  status: "NOT_CONFIGURED",
  writeEnabled: false,
};

/**
 * Eaglesoft ERP dashboard model. Drives every state from `connection.status`
 * (arch rule 10 — explicit status, never derived from absence). A 404 from the
 * not-yet-wired backend resolves to NOT_CONFIGURED so the surface renders its
 * "Connect Eaglesoft" first-run state cleanly.
 */
export function useEaglesoft() {
  const { data, isLoading, mutate } = useSWR<EaglesoftDetail>(
    "/api/integrations/eaglesoft",
    fetchEaglesoft,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );

  return {
    connection: data?.connection ?? DEFAULT_CONNECTION,
    kpis: data?.kpis,
    schedule: data?.schedule ?? [],
    isLoading,
    refresh: () => mutate(),
  };
}

/**
 * Schedule for a specific day. The base `useEaglesoft()` snapshot only carries
 * today's schedule; the ERP surface's day navigation drives this to pull other
 * days on demand (design brief §4.2). Pass `dateIso = null` to skip the fetch
 * (e.g. for today, which the base snapshot already covers, or when data is
 * RBAC-locked). Keyed per-date so SWR caches each day; a 404 from the not-yet-
 * wired backend resolves to an empty list, matching the base hook's behaviour.
 */
export function useEaglesoftSchedule(dateIso: string | null) {
  const { data, isLoading } = useSWR(
    dateIso ? ["erp-schedule", dateIso] : null,
    () => fetchEaglesoftSchedule(dateIso as string),
    { shouldRetryOnError: false },
  );
  // WARP-2135: `connected` + `reason` reach the caller so an empty schedule
  // can be reported for what it is. `entries: []` alone cannot tell "no
  // appointments today" from "this connector does not serve schedules".
  return {
    entries: data?.entries ?? [],
    connected: data?.connected ?? false,
    reason: data?.reason,
    isLoading,
  };
}

/**
 * PHI + write authority for the current dashboard user. PHI is minimum-necessary
 * and RBAC-gated (arch §14): only clinical roles (owner/admin) may view patient
 * data. The household-default `family` role (assigned to any un-grouped account)
 * and guests get the lock — matching the backend PHI_READ_ROLES. Only owner/admin
 * may enable writes or confirm a write.
 */
export function useErpAccess(): ErpAccess {
  const { user } = useAuth();
  const role = user?.role;
  const canViewPhi = role === "owner" || role === "admin";
  const privileged = role === "owner" || role === "admin";
  return {
    canViewPhi,
    canEnableWrites: privileged,
    canConfirmWrites: privileged,
  };
}
