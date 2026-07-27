/**
 * WARP-1528 / ADR-032 §3(a) (RBAC v2 T4) — the per-user feature gate.
 *
 * Layer 2 of the two-layer model. `requireFeatureAccess(moduleId, minLevel)`
 * registers BESIDE the ADR-004 `requireRole` floors (the seam `requireScope`
 * proved) and beside `requireModuleEnabled` on a module's route group. It only
 * ever NARROWS:
 *
 *   layer 1  requireRole              — the coarse enum floor, authoritative
 *   layer 1  requireModuleEnabled     — the WORKSPACE capability gate
 *   layer 2  requireFeatureAccess     — this: the PERSON's §9 grant level
 *
 * Denials are 404-CONSISTENT with `requireModuleEnabled` — byte-identical body
 * — so a feature a person may not open reads as ABSENT, not FORBIDDEN. A 403
 * would leak both that the surface exists and that somebody else can reach it;
 * the design's whole point is that a narrowed person sees a smaller Droplet,
 * not a Droplet full of locked doors. The audit trail stays honest server-side:
 * every denial emits the WARP-237 policy-violation row with its own reason, so
 * an operator can tell a per-person denial from a box-wide toggle even though
 * the client can't.
 *
 * Three passes it must NEVER narrow, all of them today's-world correctness:
 *   - `service` principals — they keep their dedicated `requireRoleOrService`
 *     paths and never resolve through this layer (T3 module comment);
 *   - a principal with no local User row (`resolveEffectiveAccess` → null) —
 *     the AUTH_ENABLED=false dev session and the Nextcloud OCS fallback. No
 *     row means no `accessRoleId` and no exceptions: there is nothing to
 *     narrow, and layer 1 is still enforcing;
 *   - a request with no principal at all — `authMiddleware` owns 401.
 * The `owner` bypass needs no special case here: §3 puts it inside the
 * resolver, which hands owners the full catalog.
 *
 * Cost: the T3 resolver is a DB read per request with no cache in v1 (its
 * deliberate decision — box scale is tens of users). Two gates can legitimately
 * match one URL (a module's prefix gate plus a route-level level check, e.g.
 * `view` on the group and `manage` on one write route), so the resolution is
 * memoised ON THE REQUEST. That is de-duplication within a single request, not
 * a cross-request cache: no staleness window is introduced.
 *
 * WARP-1585: this comment used to cite `/api/files` + `/api/files/knowledge` as
 * the overlap example. That overlap was the bug, not a feature — Express's
 * prefix mount had the `files` gate silently guarding two sibling modules'
 * namespaces. `mountModuleGates` now scopes each gate to its own namespace, so
 * two DIFFERENT modules never gate one URL. The memo stays: same-module
 * stacking is still real, and it is what keeps the resolver to one read.
 */
import type { Request, RequestHandler, Response, NextFunction } from "express";
import type { ModuleId } from "@prisma/client";
import {
  resolveEffectiveAccess,
  type EffectiveAccessResult,
} from "../services/effective-access.service.js";
import { FEATURE_LEVEL_RANK, type FeatureLevel } from "../services/access-catalog.js";
import { recordAccessDenied } from "./auth.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("feature-gate");

/** Injectable for tests — mirrors requireScope's `ScopeLoader` seam. */
export type EffectiveAccessResolver = (
  userId: string,
) => Promise<EffectiveAccessResult | null>;

/** Per-request memo slot. A symbol so it can't collide with anything else
 *  hanging off `req`, and so it disappears with the request object. */
const MEMO = Symbol.for("droplet.featureGate.effectiveAccess");

type MemoisedRequest = Request & {
  [MEMO]?: Promise<EffectiveAccessResult | null>;
};

function resolveOnce(
  req: Request,
  userId: string,
  resolve: EffectiveAccessResolver,
): Promise<EffectiveAccessResult | null> {
  const holder = req as MemoisedRequest;
  const existing = holder[MEMO];
  if (existing) return existing;
  const pending = resolve(userId);
  holder[MEMO] = pending;
  return pending;
}

/**
 * Resolve the caller's effective access ONCE per request, sharing the memo
 * with every `requireFeatureAccess` gate on the same request.
 *
 * The T3 resolver is ~7 DB round-trips with no cache in v1, so any surface
 * that wants the caller's §9 set inside a request must come through here
 * rather than calling `resolveEffectiveAccess` again. Returns `null` when
 * there is no principal, no local user id, or a `service` principal — the same
 * "nothing to narrow" set the gate passes through.
 */
export function resolveEffectiveAccessForRequest(
  req: Request,
  resolve: EffectiveAccessResolver = resolveEffectiveAccess,
): Promise<EffectiveAccessResult | null> {
  const user = req.user;
  if (!user || user.role === "service") return Promise.resolve(null);
  const userId = user.id;
  if (typeof userId !== "string" || userId.length === 0) return Promise.resolve(null);
  return resolveOnce(req, userId, resolve);
}

/**
 * Gate a route (or a whole module route group) on the caller holding at least
 * `minLevel` on `moduleId` in their resolved §9 catalog.
 *
 * @param moduleId  the App-Modules registry id — the ONE feature vocabulary.
 * @param minLevel  the §9 action level this surface needs (`view` is the
 *                  reachability floor; `act` / `manage` narrow further).
 * @param resolve   the resolver; defaults to the boot-bound T3 singleton.
 */
export function requireFeatureAccess(
  moduleId: ModuleId,
  minLevel: FeatureLevel = "view",
  resolve: EffectiveAccessResolver = resolveEffectiveAccess,
): RequestHandler {
  const needed = FEATURE_LEVEL_RANK[minLevel];

  function deny(req: Request, res: Response): void {
    // WARP-237 parity with requireRole/isAdmin denials: the refusal is
    // invisible to the client but never silent to the operator.
    recordAccessDenied(req, "feature-access-denied");
    res.status(404).json({ error: "module_disabled", module: moduleId });
  }

  return async function featureGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = req.user;
    // No principal → authMiddleware owns the 401; this gate stays out of it.
    if (!user) {
      next();
      return;
    }
    // `service` principals never resolve through layer 2 (§3).
    if (user.role === "service") {
      next();
      return;
    }
    const userId = user.id;
    if (typeof userId !== "string" || userId.length === 0) {
      // A human session without an id is an upstream contract bug; there is
      // nothing to resolve against, and layer 1 already ran.
      next();
      return;
    }

    let access: EffectiveAccessResult | null;
    try {
      access = await resolveOnce(req, userId, resolve);
    } catch (err) {
      // Fail CLOSED, exactly like requireModuleEnabled's read-error path —
      // and note that on these same prefixes the module gate would already
      // have 404'd on the same outage, so this keeps ONE observable answer
      // for one failure instead of two.
      logger.error({ err, module: moduleId, userId }, "feature_gate_read_failed");
      res.status(404).json({ error: "module_disabled", module: moduleId });
      return;
    }

    // No local row = nothing to narrow (today's world, bit-for-bit).
    if (!access) {
      next();
      return;
    }

    const held = access.features.find((f) => f.moduleId === moduleId);
    if (!held || FEATURE_LEVEL_RANK[held.level] < needed) {
      deny(req, res);
      return;
    }
    next();
  };
}
