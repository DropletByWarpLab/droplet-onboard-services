"use client";

import useSWR from "swr";
import { fetchEaglesoft } from "../api.erp";
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
  const { data, error, isLoading, mutate } = useSWR<EaglesoftDetail>(
    "/api/integrations/eaglesoft",
    fetchEaglesoft,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );

  return {
    connection: data?.connection ?? DEFAULT_CONNECTION,
    kpis: data?.kpis,
    schedule: data?.schedule ?? [],
    hasBackend: !error,
    isLoading,
    refresh: () => mutate(),
  };
}

/**
 * PHI + write authority for the current dashboard user. PHI is minimum-necessary
 * and RBAC-gated (arch §14): owner/admin/family may view patient data; guests
 * may not. Only owner/admin may enable writes or confirm a write.
 */
export function useErpAccess(): ErpAccess {
  const { user } = useAuth();
  const role = user?.role;
  const canViewPhi = role === "owner" || role === "admin" || role === "family";
  const privileged = role === "owner" || role === "admin";
  return {
    canViewPhi,
    canEnableWrites: privileged,
    canConfirmWrites: privileged,
  };
}
