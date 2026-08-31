"use client";

import useSWR from "swr";
import { fetchAppCapabilities, type AppCapabilities } from "../api";

/**
 * Which user-facing modules this Droplet is serving (WARP-1154/1155). Drives
 * the Projects sidebar entry + the /projects route: the surface hides (or
 * renders its honest "not enabled" state) ONLY when the orchestrator
 * explicitly answers `projects: false` — never inferred from request errors.
 *
 * `projects` is fail-OPEN — the inverse of useCapabilities' fail-closed
 * default, and deliberately so: the admin probe gates *optional integrations*
 * (hide when unknown), while Projects is a shipping surface. Until the probe
 * resolves — and on ANY error, including a 404 from an older orchestrator
 * that predates GET /api/capabilities — it reads as enabled, so a network blip
 * or version skew can never make a shipping surface vanish.
 *
 * The posture is now PER-FLAG rather than one rule for the object; see
 * APP_CAPABILITY_DEFAULTS below for why the two WARP-2545/2038 flags go the
 * other way.
 */
/**
 * WARP-2545 — the default is per-flag, not one posture for the object.
 *
 * `projects` stays fail-OPEN for the reason above: it is a shipping surface a
 * customer already uses, and a version skew or network blip must not make it
 * disappear.
 *
 * `crm` and `contacts` fail CLOSED. They are new and `defaultEnabled: false`,
 * so on the overwhelming majority of boxes the honest answer while the probe
 * is unresolved is "off" — and guessing "on" would render sub-tabs whose every
 * request the module gate then 404s. That dead-end (a surface offered, then a
 * `module_disabled` at the first write) is exactly what WARP-1154/WARP-1306
 * removed for Projects; opening these by default would reintroduce it. A
 * surface that has never been on cannot vanish.
 */
export const APP_CAPABILITY_DEFAULTS: AppCapabilities = {
  projects: true,
  crm: false,
  contacts: false,
};

export function useAppCapabilities(): AppCapabilities {
  const { data } = useSWR<AppCapabilities>(
    "/api/capabilities",
    fetchAppCapabilities,
    {
      // Module state changes only when the box is reconfigured; match the
      // admin-capabilities cadence.
      refreshInterval: 600_000,
      // A failing probe already resolves to APP_CAPABILITY_DEFAULTS — don't hammer it.
      shouldRetryOnError: false,
    },
  );

  return data ?? APP_CAPABILITY_DEFAULTS;
}
