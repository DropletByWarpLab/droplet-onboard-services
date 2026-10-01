/**
 * WARP-2977 P2b (ADR-059 §6, DS-005) — who may see what on the Security
 * surfaces. ONE place.
 *
 * Every Security surface asks here, never re-derives it: the feed, the area
 * list, the area chips on feed rows, the `?zone=` filter, the sources list,
 * the health header and (P4) the chat tools. A second copy of any of these
 * rules is how a hidden camera leaks through the one surface that forgot.
 *
 * WARP-2979 (P4 §6.12.2): ONE function computes the scope for a PERSON
 * (`securityScopeForPerson`). The human routes reach it through
 * `securityViewerScope`, which only builds the person from `req`; P4's chat
 * tools reach it with the acting person their own router resolved (by
 * username, then id) — so a tool answer and a dashboard page can never
 * disagree about what one person may see.
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
import { visibleCameraNames } from "./camera-access.service.js";
import {
  resolveEffectiveAccessForRequest,
  type EffectiveAccessResolver,
} from "../middleware/feature-gate.js";
import type { FeatureLevel } from "./access-catalog.js";
import type { OngoingSource } from "./security-inflight.js";

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
  /**
   * WARP-2978 PR-D — who Frigate is tracking now (camera.service's in-flight
   * map), for the incidents' "still happening" (security-incident-view.ts).
   * The incidents router reads camera.service's own when absent.
   */
  ongoing?: Pick<OngoingSource, "inView">;
}

/** Mirrored threats are owner/admin-only rows (role-based, never a grant). */
function roleMayReadThreats(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Moved from routes/security.ts (P2a) with the same semantics: role-based. */
export function mayReadThreats(req: Pick<Request, "user">): boolean {
  return roleMayReadThreats(req.user?.role);
}

/**
 * WARP-2979 — the person a Security scope is computed for: a User's `id` and
 * `role`. For a human request that is `req.user`; for P4's chat tools it is
 * the acting person the assistant router resolved. Never a service principal
 * — `_service:mcp` here scopes to nothing (camera-access fails it closed with
 * no asserted user), so a caller that forgets to resolve the person gets an
 * empty scope, not the service's.
 */
export interface SecurityPerson {
  id?: string;
  role?: string;
}

/**
 * WARP-2979 (P4 §6.12.2) — THE scope computation, for one person:
 *
 *   · `visibleCameras` — `visibleCameraNames` with a plain principal: owner/
 *     admin → `"all"`, anyone else → their CameraAccessGrant rows, read by
 *     `userId`; no role → nothing;
 *   · `mayReadThreats` — owner/admin.
 *
 * `resolve` is unused until P2b PR-2's `mayReadLocks`; pass it now so that
 * change touches no caller. A grant lookup failure REJECTS (the caller
 * answers 503, never an unfiltered page).
 */
export async function securityScopeForPerson(
  prisma: PrismaClient,
  person: SecurityPerson,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  void resolve;
  const visibleCameras = await visibleCameraNames(prisma, { id: person.id, role: person.role });
  return { visibleCameras, mayReadThreats: roleMayReadThreats(person.role) };
}

/**
 * The viewer's scope for one request: `securityScopeForPerson` for
 * `req.user`. The human routes refuse `_service:mcp` (never
 * `requireRoleOrMcpService`), so no asserted-user header is ever consulted
 * here.
 */
export async function securityViewerScope(
  prisma: PrismaClient,
  req: Pick<Request, "user">,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  return securityScopeForPerson(prisma, { id: req.user?.id, role: req.user?.role }, resolve);
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
