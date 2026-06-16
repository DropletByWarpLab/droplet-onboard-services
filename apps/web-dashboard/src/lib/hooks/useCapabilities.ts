"use client";

import useSWR from "swr";
import { fetchCapabilities, type AdminCapabilities } from "../api";

/**
 * Which optional admin surfaces (Activity #14, RAG eval #15) are wired on this
 * box. Used to gate sidebar nav entries so admins aren't led to a dead surface
 * when the backing integration (GitHub/Jira, or RAG_EVAL_URL) isn't set.
 *
 * Fail-CLOSED: until the probe resolves — and on ANY error (including the 403 a
 * non-admin gets) — every flag defaults to `false` (hidden). A nav entry that
 * briefly doesn't appear is strictly better than one that links to a 503/empty
 * page. The set flips only on a deploy/env change, so the refresh interval
 * matches useToolCatalog.
 */
const HIDDEN: AdminCapabilities = { claudeActivity: false, ragEval: false };

export function useCapabilities(): AdminCapabilities {
  const { data } = useSWR<AdminCapabilities>(
    "/api/admin/capabilities",
    fetchCapabilities,
    {
      // Capabilities change only when the box is reconfigured; 10 min is plenty.
      refreshInterval: 600_000,
      // Don't spam the 403 path for non-admins.
      shouldRetryOnError: false,
    },
  );

  return data ?? HIDDEN;
}
