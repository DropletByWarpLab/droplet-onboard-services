"use client";

import useSWR from "swr";
import { authFetch } from "../auth";

/**
 * WARP-1397 — the sidebar's module gate. Returns a predicate that answers
 * whether a user-facing module is EFFECTIVE (available && enabled) on this
 * Droplet, so a nav entry for a switched-off feature is removed rather than
 * leading to a dead, module-gated 404 (the confusing state Stefan hit after
 * the Features panel shipped).
 *
 * Fail-OPEN, deliberately (matches useAppCapabilities): until the probe
 * resolves — and on ANY error, including a 404 from an older orchestrator that
 * predates GET /api/modules — every module reads as effective, so a network
 * blip or version skew can never make a shipping surface vanish. A nav item is
 * hidden ONLY when we positively know its module is off. Core modules (chat)
 * are always effective; an id the registry doesn't know reads as effective too
 * (never hide a nav entry we can't classify).
 *
 * Self-contained (no dependency on the Features-panel api helpers) but shares
 * the `/api/modules` SWR key with them, so the Features toggle revalidating
 * that key updates the nav within one refetch — no reload.
 */

const MODULES_KEY = "/api/modules";

interface ModuleState {
  id: string;
  effective: boolean;
}
interface ModulesView {
  modules: ModuleState[];
}

async function fetchModules(): Promise<ModulesView> {
  const res = await authFetch(MODULES_KEY);
  if (!res.ok) throw new Error(`Failed to fetch modules: ${res.status}`);
  return res.json();
}

/**
 * The fail-open decision, extracted pure for testing:
 *  - probe not resolved (`data` undefined) → shown (never hide on a blip)
 *  - module known → its `effective` flag
 *  - module unknown to the registry → shown (never hide what we can't classify)
 */
export function isModuleEffective(
  data: ModulesView | undefined,
  moduleId: string,
): boolean {
  if (!data) return true;
  const m = data.modules.find((x) => x.id === moduleId);
  return m ? m.effective : true;
}

export function useModuleGate(): (moduleId: string) => boolean {
  const { data } = useSWR<ModulesView>(MODULES_KEY, fetchModules, {
    // Module state changes only when the owner reconfigures the box; the
    // Features toggle revalidates this key explicitly for the live update.
    refreshInterval: 600_000,
    shouldRetryOnError: false,
  });

  return (moduleId: string): boolean => isModuleEffective(data, moduleId);
}

export const MODULE_GATE_KEY = MODULES_KEY;
