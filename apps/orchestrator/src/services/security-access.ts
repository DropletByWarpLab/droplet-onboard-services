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
 *   · `mayReadLocks` (WARP-2977 P2b-2, DS-019) — lock_state rows, lock links,
 *     the `locks` health row and the names in a Close up's `unlockedLocks` /
 *     `uncheckedLocks` need Devices (smart_home) ≥ view on top of the
 *     Security view every Security route already sits behind. Lock state is
 *     presence data, and with `camera = null` the camera grant would
 *     otherwise show it to every Security viewer. Unresolved (no local User
 *     row) fails closed to owner/admin; a resolver failure rejects (the
 *     caller's 503), never a guess.
 */
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { visibleCameraNames } from "./camera-access.service.js";
import {
  resolveEffectiveAccessForRequest,
  type EffectiveAccessResolver,
} from "../middleware/feature-gate.js";
import { resolveEffectiveAccess, type EffectiveAccessResult } from "./effective-access.service.js";
import { FEATURE_LEVEL_RANK, type FeatureLevel } from "./access-catalog.js";
import type { SecurityLockReader } from "./security-lock-adapter.js";
import type { OngoingSource } from "./security-inflight.js";

export type { SecurityViewerScope } from "./security-viewer-scope.js";
import type { SecurityViewerScope } from "./security-viewer-scope.js";

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
   * WARP-2977 P2b-2 — the Matter lock adapter, read at request time (a
   * fresh lock list for the Areas page and link checks, the last sweep's
   * locks for labels and a Close up's `unlockedLocks` / `uncheckedLocks`,
   * whether those readings are current, the `locks` health row). Default:
   * the one index.ts started (`securityLockAdapter`); null = none is running.
   */
  locks?: () => SecurityLockReader | null;
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
 * WARP-2977 P2b-2 (DS-019) — may a person with this resolved §9 catalog see
 * door locks on the Security surfaces? Devices (smart_home) at view or above;
 * the owner's catalog always holds it (the resolver's §3 bypass).
 *
 *   · resolved → exactly that entry. An admin narrowed off Devices is out.
 *   · unresolved (null: no local User row, a service principal, no
 *     principal) → owner/admin only. Fail closed.
 */
function locksReadableWith(access: EffectiveAccessResult | null, role: string | undefined): boolean {
  if (!access) return role === "owner" || role === "admin";
  const level = access.features.find((f) => f.moduleId === "smart_home")?.level;
  return level !== undefined && FEATURE_LEVEL_RANK[level] >= FEATURE_LEVEL_RANK.view;
}

/**
 * WARP-2977 P2b-2 (DS-019) — `locksReadableWith` for one request. A resolver
 * that throws REJECTS: the caller answers 503; nothing guesses. (In
 * production the module gate has already resolved this request, and
 * `resolveEffectiveAccessForRequest` shares its memo, so this is one read.)
 */
export async function mayReadLocksFor(req: Request, resolve?: EffectiveAccessResolver): Promise<boolean> {
  return locksReadableWith(await resolveEffectiveAccessForRequest(req, resolve), req.user?.role);
}

/**
 * WARP-2979 — the person a Security scope is computed for: a User's `id` and
 * `role`. For a human request that is `req.user`; for P4's chat tools it is
 * the acting person the assistant router resolved. Never a service principal
 * — `_service:mcp` here scopes to nothing (camera-access fails it closed with
 * no asserted user, and it may not read locks), so a caller that forgets to
 * resolve the person gets an empty scope, not the service's.
 */
export interface SecurityPerson {
  id?: string;
  role?: string;
}

/** The one body behind both entry points: `access` is how this caller resolves the person's §9 catalog. */
async function scopeFor(
  prisma: PrismaClient,
  person: SecurityPerson,
  access: () => Promise<EffectiveAccessResult | null>,
): Promise<SecurityViewerScope> {
  const [visibleCameras, resolved] = await Promise.all([
    visibleCameraNames(prisma, { id: person.id, role: person.role }),
    access(),
  ]);
  return {
    visibleCameras,
    mayReadThreats: roleMayReadThreats(person.role),
    mayReadLocks: locksReadableWith(resolved, person.role),
  };
}

/**
 * WARP-2979 (P4 §6.12.2) — THE scope computation, for one person:
 *
 *   · `visibleCameras` — `visibleCameraNames` with a plain principal: owner/
 *     admin → `"all"`, anyone else → their CameraAccessGrant rows, read by
 *     `userId`; no role → nothing;
 *   · `mayReadThreats` — owner/admin;
 *   · `mayReadLocks` — `locksReadableWith` over `resolve(person.id)` (the
 *     WARP-2977 P2b-2 rule, DS-019). An owner is not resolved (the §3
 *     bypass: always true). No id, or a `service` role, is unresolved:
 *     owner/admin only, which a service never is.
 *
 * A grant lookup or resolver failure REJECTS (the caller answers 503, never
 * an unfiltered page).
 */
export async function securityScopeForPerson(
  prisma: PrismaClient,
  person: SecurityPerson,
  resolve: EffectiveAccessResolver = resolveEffectiveAccess,
): Promise<SecurityViewerScope> {
  const id = person.id;
  // An owner is never resolved: the resolver's §3 bypass gives the owner every
  // module at manage, so the answer is known (and the assistant's own actor
  // check never resolves an owner either). Unresolved reads as owner/admin.
  const resolvable = typeof id === "string" && id.length > 0 && person.role !== "service" && person.role !== "owner";
  return scopeFor(prisma, person, () => (resolvable ? resolve(id) : Promise.resolve(null)));
}

/**
 * The viewer's scope for one request: the same computation for `req.user`,
 * resolving the §9 catalog through `resolveEffectiveAccessForRequest` so it
 * shares the per-request memo with the feature gates. The human routes refuse
 * `_service:mcp` (never `requireRoleOrMcpService`), so no asserted-user
 * header is ever consulted here.
 */
export async function securityViewerScope(
  prisma: PrismaClient,
  req: Request,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  return scopeFor(prisma, { id: req.user?.id, role: req.user?.role }, () => resolveEffectiveAccessForRequest(req, resolve));
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
