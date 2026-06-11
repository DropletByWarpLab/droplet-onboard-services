/**
 * Droplet → Plane workspace role mapping.
 *
 * WARP-506 — spec WARP-498 RBAC mapping section. ADR-004 is the
 * authority for Droplet's role taxonomy; this module is the projection
 * onto Plane's workspace-level roles.
 *
 * Mapping per spec OQ5-companion table (no separate OQ — direct decision):
 *
 *   Droplet `owner`   → Plane `admin`     (full workspace control)
 *   Droplet `admin`   → Plane `admin`
 *   Droplet `family`  → Plane `member`
 *   Droplet `guest`   → Plane `guest`     (read-mostly, scoped per Plane)
 *   Droplet `service` → (denied — service principals don't get human PM access)
 *
 * Sync triggers:
 *   - OIDC `/userinfo` invocation (WARP-505 IdP flow) confirms the
 *     current role each handoff.
 *   - Droplet role-change event from auth-service — calls
 *     {@link syncPlaneUserRole} to push the new mapping to Plane.
 *
 * WARP-860 STATUS (live-probed Plane CE v0.24.1, 2026-06-11) — this
 * module is a DORMANT seam:
 *   (a) the OIDC sync trigger above is dead on CE — Plane CE has no
 *       OIDC RP support at all (paid-edition feature), so the WARP-505
 *       `/userinfo` handoff never fires;
 *   (b) `/api/v1/workspaces/<slug>/members/<id>/` 404s on CE — the
 *       members endpoint doesn't exist in the CE `/api/v1` surface —
 *       and this module has no callers anywhere in the codebase.
 * It stays as the WARP-543 per-user-attribution V2 seam (a commercial
 * edition or a CE upstream that grows the endpoint). Do NOT build new
 * CE callers on it. Auth was repointed to the runtime-provisioned
 * service token (pm-service-token.service.ts) so the seam is honest
 * when it wakes up: `DROPLET_PM_ADMIN_TOKEN` is registered nowhere in
 * Plane and 401s every call.
 *
 * Fail-CLOSED: if Plane returns an error during role push, the user is
 * locked out of PM (the existing OIDC `/userinfo` response refuses to
 * include the `member` claim Plane needs). Reconciliation alert via the
 * existing alert channel. Every error path throws PmRbacError —
 * including token-provisioning failures, which wrap as PM_API_ERROR.
 *
 * OQ5 fallback: Plane's API may not allow programmatic downgrade of the
 * workspace owner. Detected as a 403 from PATCH and surfaced as
 * `RECONCILE_REQUIRED` for the alerting layer to handle.
 */

import pino from "pino";

import { config } from "../config.js";
import type { Role } from "./jwt.service.js";
import { PmBootstrapError } from "./pm-bootstrap.service.js";
import {
  PmServiceTokenError,
  withPmServiceToken,
} from "./pm-service-token.service.js";

const logger = pino({ name: "pm-rbac" });

export type PlaneWorkspaceRole = "admin" | "member" | "guest";

const ROLE_MAP: Record<Role, PlaneWorkspaceRole | null> = {
  owner: "admin",
  admin: "admin",
  family: "member",
  guest: "guest",
  service: null,
};

const HTTP_TIMEOUT_MS = 8_000;

/** Translate a Droplet role into Plane's workspace-role enum. */
export function mapDropletRoleToPlane(role: Role): PlaneWorkspaceRole | null {
  return ROLE_MAP[role];
}

export class PmRbacError extends Error {
  constructor(
    message: string,
    readonly code:
      | "RECONCILE_REQUIRED"
      | "PM_API_ERROR"
      | "PM_API_TIMEOUT"
      | "PM_API_NETWORK",
  ) {
    super(message);
    this.name = "PmRbacError";
  }
}

/**
 * WARP-860 — module-private sentinel for the `withPmServiceToken`
 * auth-error predicate. This client checks `resp.status` inline rather
 * than throwing typed 401s, so the 401 branch throws this marker; after
 * the single re-provision retry is exhausted it is translated to the
 * public PmRbacError(PM_API_ERROR) — the fail-closed contract stays
 * "every error path is a PmRbacError".
 */
class PlaneAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneAuthRejectedError";
  }
}

/**
 * Push a Droplet user's current role to Plane. Idempotent — Plane's
 * PATCH on workspace-member is a no-op when the role already matches.
 *
 * @throws PmRbacError with code RECONCILE_REQUIRED if Plane refuses the
 *   change (typical for workspace-owner downgrade per OQ5 fallback).
 * @throws PmRbacError with code PM_API_ERROR for any other upstream
 *   failure.
 */
export async function syncPlaneUserRole(input: {
  workspaceSlug: string;
  planeUserId: string;
  dropletRole: Role;
}): Promise<{ applied: PlaneWorkspaceRole | null }> {
  const target = mapDropletRoleToPlane(input.dropletRole);
  if (target === null) {
    logger.info(
      { dropletRole: input.dropletRole, planeUserId: input.planeUserId },
      "service principal — skipping PM role sync",
    );
    return { applied: null };
  }

  // Romain's PR #322 review: `new URL(path, undefined)` throws
  // TypeError("Invalid URL") if DROPLET_PM_API_URL was never registered
  // in config.ts's Zod schema (so resolves to undefined at runtime).
  // Surface a typed PmRbacError instead — the fail-closed posture
  // documented in the module header depends on every error path being
  // a PmRbacError, not a raw TypeError or DOMException.
  if (!config.DROPLET_PM_API_URL) {
    throw new PmRbacError(
      "DROPLET_PM_API_URL not configured — refusing to sync PM role",
      "PM_API_ERROR",
    );
  }
  const url = new URL(
    `/api/v1/workspaces/${encodeURIComponent(input.workspaceSlug)}/members/${encodeURIComponent(input.planeUserId)}/`,
    config.DROPLET_PM_API_URL,
  );

  try {
    // WARP-860 — authenticate with the runtime-provisioned service token;
    // a Plane 401 (stale cache after a workspace reset) invalidates and
    // retries exactly once with a freshly provisioned token.
    return await withPmServiceToken(
      (token) =>
        patchMemberRole(url, token, input.planeUserId, input.dropletRole, target),
      (err) => err instanceof PlaneAuthRejectedError,
    );
  } catch (err) {
    if (err instanceof PmRbacError) throw err;
    // The 401 survived the single re-provision retry — Plane genuinely
    // rejects the service token. Fail closed as PM_API_ERROR.
    if (err instanceof PlaneAuthRejectedError) {
      throw new PmRbacError(err.message, "PM_API_ERROR");
    }
    // Token provisioning / Plane bootstrap failures — the PM stack is
    // not onboarded or unreachable. Same fail-closed translation so the
    // caller contract stays "every error path is a PmRbacError".
    if (err instanceof PmServiceTokenError || err instanceof PmBootstrapError) {
      throw new PmRbacError(
        `Plane service-token provisioning failed: ${err.message}`,
        "PM_API_ERROR",
      );
    }
    throw err;
  }
}

/**
 * One PATCH attempt with the given service token. Throws
 * PlaneAuthRejectedError on a Plane 401 (the `withPmServiceToken`
 * retry signal); every other failure path is a typed PmRbacError.
 */
async function patchMemberRole(
  url: URL,
  token: string,
  planeUserId: string,
  dropletRole: Role,
  target: PlaneWorkspaceRole,
): Promise<{ applied: PlaneWorkspaceRole }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        "X-API-Key": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: target }),
      signal: controller.signal,
    });

    if (resp.status === 401) {
      throw new PlaneAuthRejectedError(
        `Plane rejected the service token on PATCH member for user ${planeUserId}`,
      );
    }
    if (resp.status === 403) {
      // OQ5 fallback — Plane refused the change (typically when the
      // target is the workspace owner). Surface for manual reconciliation.
      logger.warn(
        {
          dropletRole,
          planeUserId,
          target,
          event_type: "pm_rbac_reconcile_required",
        },
        "Plane refused role change — manual reconciliation required",
      );
      throw new PmRbacError(
        `Plane refused role change for user ${planeUserId}`,
        "RECONCILE_REQUIRED",
      );
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new PmRbacError(
        `Plane PATCH member returned ${resp.status}: ${detail}`,
        "PM_API_ERROR",
      );
    }
    return { applied: target };
  } catch (err) {
    // Romain's PR #322 review: when controller.abort() fires the
    // 8-second timeout, fetch() throws a DOMException with
    // name="AbortError". The previous try/finally let it escape as a
    // raw DOMException, breaking `instanceof PmRbacError` checks at
    // every caller and silently violating the module's fail-closed
    // contract. Translate to a typed PmRbacError. Other network-layer
    // failures (DNS, refused connection) come through as TypeError
    // with name="TypeError" — same handling.
    if (err instanceof PmRbacError || err instanceof PlaneAuthRejectedError) {
      throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new PmRbacError(
        `Plane PATCH member timed out after ${HTTP_TIMEOUT_MS}ms`,
        "PM_API_TIMEOUT",
      );
    }
    throw new PmRbacError(
      `Plane PATCH member network error: ${err instanceof Error ? err.message : String(err)}`,
      "PM_API_NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}
