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
 *   · `mayReadLocks` (WARP-2977 P2b-2, DS-019) — lock_state rows, lock links,
 *     the `locks` health row and the names in a Close up's `unlockedLocks`
 *     need Devices (smart_home) ≥ view on top of the Security view every
 *     Security route already sits behind. Lock state is presence data, and
 *     with `camera = null` the camera grant would otherwise show it to every
 *     Security viewer. Unresolved (no local User row) fails closed to
 *     owner/admin; a resolver failure rejects (the caller's 503), never a
 *     guess.
 */
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { principalFromRequest, visibleCameraNames } from "./camera-access.service.js";
import {
  resolveEffectiveAccessForRequest,
  type EffectiveAccessResolver,
} from "../middleware/feature-gate.js";
import { FEATURE_LEVEL_RANK, type FeatureLevel } from "./access-catalog.js";

export interface SecurityViewerScope {
  /** `"all"` for owner/admin; otherwise exactly the granted Frigate camera names. */
  visibleCameras: "all" | ReadonlySet<string>;
  /** Mirrored threats (and the threat_mirror health row) — owner/admin only. */
  mayReadThreats: boolean;
  /** Lock rows, lock links, the `locks` health row (WARP-2977 P2b-2, DS-019) — `mayReadLocksFor`. */
  mayReadLocks: boolean;
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
 * WARP-2977 P2b-2 (DS-019) — may this person see door locks on the Security
 * surfaces? Devices (smart_home) at view or above in their resolved §9
 * catalog; the owner's catalog always holds it (the resolver's §3 bypass).
 *
 *   · resolved → exactly that entry. An admin narrowed off Devices is out.
 *   · unresolved (null: no local User row, a service principal, no
 *     principal) → owner/admin only. Fail closed.
 *   · the resolver throws → REJECTS. The caller answers 503; nothing guesses.
 *     (In production the module gate has already resolved this request, and
 *     `resolveEffectiveAccessForRequest` shares its memo, so this is one read.)
 */
export async function mayReadLocksFor(req: Request, resolve?: EffectiveAccessResolver): Promise<boolean> {
  const access = await resolveEffectiveAccessForRequest(req, resolve);
  if (!access) return req.user?.role === "owner" || req.user?.role === "admin";
  const level = access.features.find((f) => f.moduleId === "smart_home")?.level;
  return level !== undefined && FEATURE_LEVEL_RANK[level] >= FEATURE_LEVEL_RANK.view;
}

/**
 * The viewer's scope for one request. `resolve` is `deps.resolve` (the §9
 * resolver behind the gates); it decides `mayReadLocks`.
 */
export async function securityViewerScope(
  prisma: PrismaClient,
  req: Request,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  const [visibleCameras, mayReadLocks] = await Promise.all([
    visibleCameraNames(prisma, principalFromRequest(req)),
    mayReadLocksFor(req, resolve),
  ]);
  return { visibleCameras, mayReadThreats: mayReadThreats(req), mayReadLocks };
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
