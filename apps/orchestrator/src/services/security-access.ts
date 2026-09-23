/**
 * WARP-2977 P2b (ADR-059 §6, DS-005) — who may see what on the Security
 * surfaces. ONE place.
 *
 * Every Security surface asks here, never re-derives it: the feed, the area
 * list, the area chips on feed rows, the `?zone=` filter, the sources list,
 * the health header and (P4) the chat tools. A second copy of any of these
 * rules is how a hidden camera leaks through the one surface that forgot.
 *
 *   · `visibleCameras` — CameraAccessGrant, via camera-access.service. A
 *     camera outside the grant is ABSENT (no row, no count, no area that is
 *     only made of it), never redacted.
 *   · `mayReadThreats` — mirrored warn/err network/auth ActivityRows point at
 *     owner/admin-only rows, so they are owner/admin-only here too.
 *
 * PR-2 (the Matter lock adapter) adds `mayReadLocks` — smart_home ≥ view,
 * resolved through `resolveEffectiveAccessForRequest(req, resolve)`, fail
 * closed to owner/admin on a null resolution. It is deliberately NOT a field
 * yet: a PR-1 scope with a constant `false` would be a rule nobody enforces,
 * and something would come to depend on it. PR-2 adds the field and every
 * reader together; `resolve` is already in the signature so no caller has
 * to change when it does.
 */
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { principalFromRequest, visibleCameraNames } from "./camera-access.service.js";
import {
  resolveEffectiveAccessForRequest,
  type EffectiveAccessResolver,
} from "../middleware/feature-gate.js";
import type { FeatureLevel } from "./access-catalog.js";

export interface SecurityViewerScope {
  /** `"all"` for owner/admin; otherwise exactly the granted Frigate camera names. */
  visibleCameras: "all" | ReadonlySet<string>;
  /** Mirrored threats (and the threat_mirror health row) — owner/admin only. */
  mayReadThreats: boolean;
}

/**
 * The deps every Security router takes (`createSecurityRouter`,
 * `createSecurityZonesRouter`, `createSecuritySiteRouter`). All optional: the
 * production mount passes none and gets the boot-bound resolver, the real
 * clock and the real Frigate config fetch.
 */
export interface SecurityRouteDeps {
  /** The §9 resolver behind `requireFeatureAccess` and the scope; tests inject the fixture. */
  resolve?: EffectiveAccessResolver;
  /** The clock (mode resolution, hours preview, health staleness). */
  now?: () => Date;
  /** Frigate's `/api/config`, for the sources list and link checks (one fetch, with a timeout). */
  frigateConfig?: () => Promise<unknown>;
}

/** Moved from routes/security.ts (P2a) with the same semantics: role-based. */
export function mayReadThreats(req: Pick<Request, "user">): boolean {
  return req.user?.role === "owner" || req.user?.role === "admin";
}

/**
 * The viewer's scope for one request. `resolve` is unused until PR-2's
 * `mayReadLocks`; pass `deps.resolve` now so that change touches no caller.
 */
export async function securityViewerScope(
  prisma: PrismaClient,
  req: Request,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  void resolve;
  const visibleCameras = await visibleCameraNames(prisma, principalFromRequest(req));
  return { visibleCameras, mayReadThreats: mayReadThreats(req) };
}

/**
 * The viewer's resolved per-person Security level, for the READ surfaces
 * whose OUTPUT (not reachability — the gates own that) depends on it:
 *
 *   · a FeatureLevel — the `security` entry of the resolved §9 catalog;
 *   · `"none"` — resolved, but the catalog holds no `security` entry. Such a
 *     person cannot pass the route's view gate, so a Security route never
 *     sees it; any other caller must read it as BELOW view (fail closed —
 *     never as "unresolved");
 *   · `null` — nothing to resolve: no principal, a `service` principal, or no
 *     local User row (the AUTH_ENABLED=false dev session, the Nextcloud
 *     fallback). The same set `requireFeatureAccess` passes through
 *     un-narrowed, so the role floor alone decides.
 *
 * Goes through `resolveEffectiveAccessForRequest`, so it shares the
 * per-request memo with the feature gates (no second resolver read). A
 * resolver failure REJECTS; the caller answers 503, it never guesses a level.
 */
export async function securityLevelFor(
  req: Request,
  resolve?: EffectiveAccessResolver,
): Promise<FeatureLevel | "none" | null> {
  const access = await resolveEffectiveAccessForRequest(req, resolve);
  if (!access) return null;
  return access.features.find((f) => f.moduleId === "security")?.level ?? "none";
}

/**
 * Route 3 (GET /api/security/zones) honours `include=archived` only when the
 * role is owner/admin AND the resolved level is `manage` or unresolved
 * (`null`) — mirroring `requireRole('owner','admin')` plus
 * `requireFeatureAccess('security','manage')`'s pass-through on a null
 * resolution. For anyone else the flag is IGNORED (a filter, not a gate: no
 * 403/404, so a page load never produces a denial). ONE place for the rule.
 */
export function mayListArchivedZones(
  req: Pick<Request, "user">,
  level: FeatureLevel | "none" | null,
): boolean {
  const role = req.user?.role;
  if (role !== "owner" && role !== "admin") return false;
  return level === "manage" || level === null;
}
