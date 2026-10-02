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
 * username, then id) — through `securityScopeWithoutLocks` (the same cameras
 * and threats, door locks off) on the tools that do not speak of locks, and
 * directly on the two that do (P4 PR-4: A3's lock changes, A4's lock links) —
 * so a tool answer and a dashboard page can never disagree about what one
 * person may see, and the tools never see more than the page.
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
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { locksReadableWith } from "./security-lock-access.js";
import type { FeatureLevel } from "./access-catalog.js";
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
 *   · `mayReadThreats` — owner/admin;
 *   · `mayReadLocks` — Devices (smart_home) ≥ view in the person's resolved
 *     §9 catalog (`locksReadableWith`, the leaf rule); `resolve` reads that catalog by `person.id`.
 *
 * A grant lookup or resolver failure REJECTS (the caller answers 503, never
 * an unfiltered page).
 */
export async function securityScopeForPerson(
  prisma: PrismaClient,
  person: SecurityPerson,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  // The same "nothing to resolve" set as `resolveEffectiveAccessForRequest`: no id, or a service principal.
  const catalog = !person.id || person.role === "service" ? null : (resolve ?? resolveEffectiveAccess)(person.id);
  const [scope, access] = await Promise.all([securityScopeWithoutLocks(prisma, person), catalog]);
  return { ...scope, mayReadLocks: locksReadableWith(access, person.role) };
}

/**
 * `securityScopeForPerson` with door locks OFF (`mayReadLocks: false`), and no
 * resolver read: for a surface that does not speak of locks — the assistant's
 * A1, A2 and A5 (routes/security-assistant.ts) answer for cameras, and lock
 * state is presence data. Always the safe side of `securityScopeForPerson`, never
 * wider; it is also where that function gets its cameras and threats from, so
 * the two cannot disagree about either.
 */
export async function securityScopeWithoutLocks(prisma: PrismaClient, person: SecurityPerson): Promise<SecurityViewerScope> {
  return {
    visibleCameras: await visibleCameraNames(prisma, { id: person.id, role: person.role }),
    mayReadThreats: roleMayReadThreats(person.role),
    mayReadLocks: false,
  };
}

/**
 * The viewer's scope for one request: `securityScopeForPerson` for
 * `req.user`, its §9 catalog read through the request's memo (shared with the
 * feature gates: one resolver read per request). The human routes refuse
 * `_service:mcp` (never `requireRoleOrMcpService`), so no asserted-user
 * header is ever consulted here.
 */
export async function securityViewerScope(
  prisma: PrismaClient,
  req: Request,
  resolve?: EffectiveAccessResolver,
): Promise<SecurityViewerScope> {
  return securityScopeForPerson(prisma, { id: req.user?.id, role: req.user?.role }, () =>
    resolveEffectiveAccessForRequest(req, resolve),
  );
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
