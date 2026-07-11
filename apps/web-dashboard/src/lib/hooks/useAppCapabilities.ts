"use client";

import useSWR from "swr";
import { fetchAppCapabilities, type AppCapabilities } from "../api";

/**
 * Which user-facing modules this Droplet is serving (WARP-1154/1155). Drives
 * the Projects sidebar entry + the /projects route: the surface hides (or
 * renders its honest "not enabled" state) ONLY when the orchestrator
 * explicitly answers `projects: false` — never inferred from request errors.
 *
 * Fail-OPEN — the inverse of useCapabilities' fail-closed default, and
 * deliberately so: the admin probe gates *optional integrations* (hide when
 * unknown), while Projects is a shipping default-ON surface. Until the probe
 * resolves — and on ANY error, including a 404 from an older orchestrator
 * that predates GET /api/capabilities — every module reads as enabled, so a
 * network blip or version skew can never make a shipping surface vanish.
 */
const ALL_ON: AppCapabilities = { projects: true };

export function useAppCapabilities(): AppCapabilities {
  const { data } = useSWR<AppCapabilities>(
    "/api/capabilities",
    fetchAppCapabilities,
    {
      // Module state changes only when the box is reconfigured; match the
      // admin-capabilities cadence.
      refreshInterval: 600_000,
      // A failing probe already reads as "all on" — don't hammer it.
      shouldRetryOnError: false,
    },
  );

  return data ?? ALL_ON;
}
