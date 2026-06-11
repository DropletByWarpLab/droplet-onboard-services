/**
 * WARP-860 — shared PlaneApiError → tool-result mapping for the `pm_*`
 * handlers.
 *
 * A Plane 401 means the service token the orchestrator forwarded via
 * `ctx.pmApiKey` was missing, stale (Plane workspace was reset), or the
 * legacy env-var fallback was used against a CE box where
 * DROPLET_PM_ADMIN_TOKEN is registered nowhere. All nine handlers
 * surface it as PM_AUTH_FAILED so the orchestrator's agent loop can
 * invalidate its token cache and re-provision on the next dispatch.
 */
import type { ToolResult } from "../../types.js";

import { PlaneApiError } from "./pm-client.js";

export const PM_AUTH_FAILED_MESSAGE =
  "Plane rejected the service token — it may not be provisioned yet";

/**
 * Returns the PM_AUTH_FAILED tool result for a Plane 401, or `null`
 * when the caller should apply its own (handler-specific) mapping.
 */
export function mapPlaneAuthError(err: unknown): ToolResult | null {
  if (err instanceof PlaneApiError && err.status === 401) {
    return {
      ok: false,
      status: "error",
      error: { code: "PM_AUTH_FAILED", message: PM_AUTH_FAILED_MESSAGE },
    };
  }
  return null;
}
