"use client";

import useSWR from "swr";
import { fetchCapabilities, type AdminCapabilities } from "../api";

/**
 * Which optional admin surfaces (Activity #14, RAG eval #15) are wired on this
 * box. Used to gate sidebar nav entries so admins aren't led to a dead surface
 * when the backing integration isn't set: for Activity that is the developer
 * flag DROPLET_DEV_ENGINEERING_DASHBOARD (WARP-3433, off on every customer box)
 * plus GitHub/Jira; for RAG eval, RAG_EVAL_URL.
 *
 * Fail-CLOSED: until the probe resolves — and on ANY error (including the 403 a
 * non-admin gets) — every flag defaults to `false` (hidden). A nav entry that
 * briefly doesn't appear is strictly better than one that links to a 503/empty
 * page. The set flips only on a deploy/env change, so the refresh interval
 * matches useToolCatalog.
 */
const HIDDEN: AdminCapabilities = { claudeActivity: false, ragEval: false };

function useCapabilitiesProbe() {
  return useSWR<AdminCapabilities>("/api/admin/capabilities", fetchCapabilities, {
    // Capabilities change only when the box is reconfigured; 10 min is plenty.
    refreshInterval: 600_000,
    // Don't spam the 403 path for non-admins.
    shouldRetryOnError: false,
  });
}

export function useCapabilities(): AdminCapabilities {
  return useCapabilitiesProbe().data ?? HIDDEN;
}

/**
 * WARP-3433 — a surface that ships dark and is ABSENT, not empty: its page
 * renders nothing until the probe has answered, then a plain
 * 404 unless the capability is on. A failed probe (a non-admin's 403, an older
 * orchestrator) is "off": never a flash of the page, never a card hinting that
 * the product has it.
 */
export function useCapabilityState(
  key: keyof AdminCapabilities,
): "unresolved" | "on" | "off" {
  const { data, error } = useCapabilitiesProbe();
  if (data) return data[key] ? "on" : "off";
  return error ? "off" : "unresolved";
}
