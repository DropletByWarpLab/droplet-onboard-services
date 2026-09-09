/**
 * WARP-1260 (T8) — requireSpaceAccess space middleware.
 *
 * ADR-029 §3.1 route-guard truth table for the department/team enforcement
 * model (see docs/TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md §3 in the
 * handbook). Composed AFTER `authMiddleware` (needs `req.user`); the space
 * a request targets is `personal` (default), the `household` alias, or
 * `dept:<uuid>` — resolved from `req.query.space` / `req.body.space` by
 * default, or from a caller-supplied resolver for routes that carry the
 * space id somewhere else (path param, a pre-resolved value, …).
 *
 *   caller       | personal | dept/household (active)                | pending/failed/archiving/archived | unknown/malformed
 *   ─────────────┼──────────┼─────────────────────────────────────────┼────────────────────────────────────┼───────────────────
 *   owner/admin  | pass     | SHORT-CIRCUIT pass + ActivityRow when    | 403                                 | 403
 *                |          | not a member (audited see-all)          |                                     |
 *   family       | pass     | pass iff membership.right >= minRight   | 403                                 | 403
 *   guest        | pass     | pass iff member AND minRight === reader | 403                                 | 403
 *   `_service:mcp`| pass    | asserted user's (X-Nextcloud-User →     | 403                                 | 403
 *                |          | local User) membership checked, same    |                                     |
 *                |          | rule as family/guest above              |                                     |
 *   other service| pass     | 403 (no asserted user to check)         | 403                                 | 403
 *
 * Membership lookup is ONE indexed `findUnique` — no Redis ACL cache, so
 * revocation has zero staleness window (brief §3.1). EVERY denial emits a
 * `recordAccessDenied` ActivityRow (mirrors `requireRole`); every admin
 * non-member entry into an active dept space ALSO emits an (allowed)
 * audited "admin-space-entry" row — see-all is loud by design.
 *
 * `checkSpaceAccess(prisma, req, caller, departmentId, minRight)` is the
 * middleware's core check, extracted so routes that already have a
 * resolved `departmentId` (the file-registry metadata gate:
 * comments/tags/citations/editor-session resolve `ncFileId →
 * File.departmentId` via `resolveFileDepartment`, see
 * `services/file-registry.service.ts`) can invoke the SAME authz path
 * inline, post-resolution, without re-deriving a `?space=` token.
 * `requireSpaceAccess` is a thin wrapper: it resolves the raw space value
 * to a `departmentId | null` (handling the `personal` / `household`-alias
 * / `dept:<uuid>` / malformed cases) and then calls `checkSpaceAccess`.
 */
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient, DepartmentRight } from "@prisma/client";
import { z } from "zod";
import { recordAccessDenied } from "./auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("space-access");

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by `requireSpaceAccess` on an allowed request: the resolved
       * department id (`null` for `personal`). Downstream handlers may
       * read it instead of re-parsing `?space=`.
       */
      spaceDepartmentId?: string | null;
    }
  }
}

// ── Rights ranking ──────────────────────────────────────────────────

/** `reader < contributor < manager` — must mirror the Prisma
 * `DepartmentRight` enum ordering (brief §2). */
export const RIGHT_RANK: Record<DepartmentRight, number> = {
  reader: 0,
  contributor: 1,
  manager: 2,
};

/** True iff `actual` meets or exceeds `min` on the rights ladder. */
export function rightMeets(actual: DepartmentRight, min: DepartmentRight): boolean {
  return RIGHT_RANK[actual] >= RIGHT_RANK[min];
}

/**
 * WARP-2585 — every ACTIVE department this caller may READ, as one query.
 *
 * The same truth table as `checkSpaceAccess(..., "reader")`, read in bulk
 * rather than per subject. It exists because a LISTING that hides rows is not
 * a denial: `checkSpaceAccess` audits every refusal (`recordAccessDenied` →
 * ActivityRow), so calling it per row would emit one warn row per hidden
 * document per page load and drown the audit trail in non-events. It also
 * turns an N-row page into 1 query instead of N.
 *
 * Two readers of one table drift, so the equivalence is PINNED across the
 * role × membership matrix in `__tests__/entity-link.pg.test.ts`. If you change
 * the rules above, that test is what tells you this went stale.
 *
 * Deliberately NOT for gating a single known department — use
 * `checkSpaceAccess` there, so the denial IS audited. This answers only "which
 * of these may I show at all".
 *
 * `caller.id` is the LOCAL `User.id` UUID, never an NC username or a service
 * principal string — the same contract `SpaceAccessCaller` carries.
 */
export async function readableDepartmentIdsFor(
  prisma: PrismaClient,
  caller: SpaceAccessCaller,
): Promise<ReadonlySet<string>> {
  if (caller.role === "owner" || caller.role === "admin") {
    // Audited see-all is an ALLOWED bypass in checkSpaceAccess, so it must be
    // an allowed bypass here too. The ActivityRow belongs to a real entry into
    // a space, not to a list that happened to include one.
    const all = await prisma.department.findMany({
      where: { state: "active" },
      select: { id: true },
    });
    return new Set(all.map((d) => d.id));
  }

  // family and guest alike: membership decides, and `reader` is the floor of
  // the rights ladder so `rightMeets(right, "reader")` holds for every right —
  // which is also why the guest-write branch of checkSpaceAccess has no
  // counterpart here. `removing` is a committed revocation whose Nextcloud
  // push has not converged; treating it as absent is what makes "policy access
  // dies at commit" true.
  const memberships = await prisma.departmentMembership.findMany({
    where: {
      userId: caller.id,
      syncState: { not: "removing" },
      department: { state: "active" },
    },
    select: { department: { select: { id: true } } },
  });
  return new Set(memberships.map((m) => m.department.id));
}

// ── Space-token parsing ─────────────────────────────────────────────

const uuidSchema = z.string().uuid();

type SpaceToken =
  | { kind: "personal" }
  | { kind: "household" }
  | { kind: "dept"; id: string }
  | { kind: "malformed" };

/**
 * Parse a raw `?space=` / body `space` value. Absent/empty/"personal" all
 * mean personal (the default). "household" is the legacy WS-5 alias for
 * the seeded `kind=HOUSEHOLD` department. `dept:<uuid>` addresses any
 * other department/team row by id. Anything else — wrong type, an
 * unrecognized literal, or a `dept:` prefix with a non-UUID suffix — is
 * `malformed` and fails closed (never silently falls back to personal).
 */
export function parseSpaceValue(raw: unknown): SpaceToken {
  if (raw === undefined || raw === null || raw === "" || raw === "personal") {
    return { kind: "personal" };
  }
  if (typeof raw !== "string") return { kind: "malformed" };
  if (raw === "household") return { kind: "household" };
  if (raw.startsWith("dept:")) {
    const id = raw.slice("dept:".length);
    if (!uuidSchema.safeParse(id).success) return { kind: "malformed" };
    return { kind: "dept", id };
  }
  return { kind: "malformed" };
}

async function resolveHouseholdDepartmentId(
  prisma: PrismaClient,
): Promise<string | null> {
  const dept = await prisma.department.findFirst({
    where: { kind: "HOUSEHOLD" },
    select: { id: true },
  });
  return dept?.id ?? null;
}

/**
 * Read-only resolution of `?space=` → `departmentId | null`, WITHOUT any
 * authorization check. Now that write routes thread + gate their own space
 * (WARP-1262/T10 — `requireSpaceAccess` populates `req.spaceDepartmentId`,
 * which write handlers use directly for the file-registry stamp), this
 * helper is kept for any read-only/metadata caller that needs the same
 * resolution WITHOUT a route-level access check. Returns null for
 * personal, malformed, or any space that doesn't resolve to an ACTIVE
 * department (never registers a file against a
 * pending/failed/archiving/archived/unknown space).
 */
export async function resolveDepartmentIdForSpaceReadOnly(
  prisma: PrismaClient,
  rawSpace: unknown,
): Promise<string | null> {
  const token = parseSpaceValue(rawSpace);
  if (token.kind === "personal" || token.kind === "malformed") return null;

  const departmentId =
    token.kind === "household"
      ? await resolveHouseholdDepartmentId(prisma)
      : token.id;
  if (!departmentId) return null;

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { state: true },
  });
  return dept && dept.state === "active" ? departmentId : null;
}

/**
 * Resolve a raw `?space=`/body `space` token to a `departmentId | null`
 * WITHOUT any access check (existence/active-state/rights are checked
 * downstream by `checkSpaceAccess`). Shared by `requireSpaceAccess` and by
 * routes that need to resolve TWO spaces in one request — the move/copy
 * cross-space dual-check (WARP-1262/T10) calls this once per side, then
 * runs `checkSpaceAccess` against each resolved id with the side's own
 * `minRight`, so both a malformed source AND a malformed target fail
 * closed with the same audited error the single-space guard would give.
 */
export async function resolveRawSpaceToDepartmentId(
  prisma: PrismaClient,
  rawSpace: unknown,
): Promise<{ ok: true; departmentId: string | null } | { ok: false; reason: string; error: string }> {
  const token = parseSpaceValue(rawSpace);
  if (token.kind === "personal") {
    return { ok: true, departmentId: null };
  }
  if (token.kind === "malformed") {
    return { ok: false, reason: "space-malformed", error: "Forbidden: malformed space id" };
  }
  if (token.kind === "household") {
    const id = await resolveHouseholdDepartmentId(prisma);
    if (!id) {
      return { ok: false, reason: "space-unknown", error: "Forbidden: unknown space" };
    }
    return { ok: true, departmentId: id };
  }
  // dept:<uuid> — existence + active-state checked by checkSpaceAccess.
  return { ok: true, departmentId: token.id };
}

// ── Core truth-table check ──────────────────────────────────────────

export interface SpaceAccessCaller {
  /** LOCAL `User.id` UUID — never an NC username or a service-principal
   * string. Callers resolving a service-asserted user MUST swap this in
   * before calling; `checkSpaceAccess` has no header awareness. */
  id: string;
  role: string;
}

export type SpaceCheckResult =
  | { allowed: true; departmentId: string | null }
  | { allowed: false; status: number; error: string };

/**
 * Core access check for a single already-resolved `departmentId`
 * (`null` = personal, always allowed). See module doc for the truth
 * table. Every denial and every admin non-member entry is audited here —
 * callers (the middleware AND the metadata-gate call sites) never need to
 * duplicate the ActivityRow emission.
 */
export async function checkSpaceAccess(
  prisma: PrismaClient,
  req: Request,
  caller: SpaceAccessCaller,
  departmentId: string | null,
  minRight: DepartmentRight,
): Promise<SpaceCheckResult> {
  if (departmentId === null) {
    return { allowed: true, departmentId: null };
  }

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, state: true },
  });
  if (!dept) {
    recordAccessDenied(req, "space-unknown");
    return { allowed: false, status: 403, error: "Forbidden: unknown space" };
  }
  if (dept.state !== "active") {
    recordAccessDenied(req, `space-not-active:${dept.state}`);
    return { allowed: false, status: 403, error: "Forbidden: space is not active" };
  }

  if (caller.role === "owner" || caller.role === "admin") {
    const membership = await prisma.departmentMembership.findUnique({
      where: { departmentId_userId: { departmentId: dept.id, userId: caller.id } },
      select: { id: true, syncState: true },
    });
    if (!membership || membership.syncState === "removing") {
      // Audited see-all — an ALLOWED admin bypass, not a denial. Loud by
      // design (brief §3.5 tier 1).
      void recordActivity({
        kind: "auth",
        severity: "info",
        sourceIcon: "eye",
        what: "Admin space entry (non-member)",
        sub: `${req.method} ${req.path}`,
        refs: {
          departmentId: dept.id,
          path: req.path,
          method: req.method,
          role: caller.role,
        },
        actor: actorFromRequest({ user: { id: caller.id, role: caller.role } }),
      });
    }
    return { allowed: true, departmentId: dept.id };
  }

  const membership = await prisma.departmentMembership.findUnique({
    where: { departmentId_userId: { departmentId: dept.id, userId: caller.id } },
    select: { right: true, syncState: true },
  });
  // `removing` is a membership row that has committed its revocation intent
  // (department-membership.service.ts's removeMembership tx) but has not yet
  // been deleted — because the immediate NC push failed and the row is
  // waiting for the reconciler's retry (brief §4: "Policy access dies at
  // commit; byte access at the NC call"). Treating it as absent here is what
  // makes that true: policy access is denied the instant the tx commits,
  // regardless of how long the NC-side removal takes to converge.
  if (!membership || membership.syncState === "removing") {
    recordAccessDenied(req, "space-not-member");
    return { allowed: false, status: 403, error: "Forbidden: not a member of this space" };
  }

  if (caller.role === "guest" && minRight !== "reader") {
    recordAccessDenied(req, "space-guest-write");
    return { allowed: false, status: 403, error: "Forbidden: guests have read-only access" };
  }

  if (!rightMeets(membership.right, minRight)) {
    recordAccessDenied(req, "space-insufficient-right");
    return {
      allowed: false,
      status: 403,
      error: "Forbidden: insufficient rights for this space",
    };
  }

  return { allowed: true, departmentId: dept.id };
}

// ── Express middleware ──────────────────────────────────────────────

export type SpaceResolver = (req: Request) => unknown;

export interface RequireSpaceAccessOptions {
  /** How to pull the raw space token off the request. Defaults to
   * `req.query.space ?? req.body?.space`. */
  resolveSpace?: SpaceResolver;
}

function defaultSpaceResolver(req: Request): unknown {
  const fromQuery = req.query?.space;
  if (fromQuery !== undefined) return fromQuery;
  const body = req.body as Record<string, unknown> | undefined;
  return body?.space;
}

/**
 * Build a middleware that gates a route by `minRight` on the request's
 * resolved space. Mounts after `authMiddleware`. Fail-closed on every
 * branch — see module doc for the truth table.
 */
export function requireSpaceAccess(
  prisma: PrismaClient,
  minRight: DepartmentRight,
  opts: RequireSpaceAccessOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const resolveSpace = opts.resolveSpace ?? defaultSpaceResolver;

  return async function spaceAccessGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const role = req.user?.role;
    const userId = req.user?.id;
    if (
      typeof role !== "string" ||
      role.length === 0 ||
      typeof userId !== "string" ||
      userId.length === 0
    ) {
      recordAccessDenied(req, "space-no-session");
      res.status(403).json({ error: "Forbidden: no session" });
      return;
    }

    try {
      const rawSpace = resolveSpace(req);
      const token = parseSpaceValue(rawSpace);
      let caller: SpaceAccessCaller = { id: userId, role };

      // Service principals: `requireRoleOrMcpService` semantics — only
      // the MCP service, asserting a real user via X-Nextcloud-User, may
      // reach a non-personal space; every other service principal is
      // confined to personal (mirrors requireRoleOrMcpService's role
      // gate, which this middleware does not replace).
      if (role === "service") {
        if (userId === "_service:mcp") {
          if (token.kind !== "personal") {
            const assertedNcUser = (req.header("x-nextcloud-user") ?? "").trim();
            if (!assertedNcUser) {
              recordAccessDenied(req, "space-mcp-no-asserted-user");
              res
                .status(403)
                .json({ error: "Forbidden: no asserted user for space access" });
              return;
            }
            const localUser = await prisma.user.findUnique({
              where: { nextcloudUsername: assertedNcUser },
              select: { id: true, role: true },
            });
            if (!localUser) {
              recordAccessDenied(req, "space-mcp-unresolved-asserted-user");
              res
                .status(403)
                .json({ error: "Forbidden: asserted user not provisioned" });
              return;
            }
            caller = { id: localUser.id, role: localUser.role };
          }
        } else if (token.kind !== "personal") {
          recordAccessDenied(req, "space-service-denied");
          res
            .status(403)
            .json({ error: "Forbidden: service principal cannot access this space" });
          return;
        }
      }

      const resolved = await resolveRawSpaceToDepartmentId(prisma, rawSpace);
      if (!resolved.ok) {
        recordAccessDenied(req, resolved.reason);
        res.status(403).json({ error: resolved.error });
        return;
      }
      const departmentId = resolved.departmentId;

      const result = await checkSpaceAccess(prisma, req, caller, departmentId, minRight);
      if (!result.allowed) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      req.spaceDepartmentId = result.departmentId;
      next();
    } catch (err) {
      logger.error({ err }, "requireSpaceAccess: unexpected error");
      res.status(500).json({ error: "Space access check failed; please retry" });
    }
  };
}

/**
 * A resolved departmentId in the WIRE space vocabulary `/files?space=`
 * understands: the seeded HOUSEHOLD department is addressed as the legacy
 * `"shared"` literal there; every other department/team is `dept:<uuid>`.
 * `routes/files.ts` translates `"shared"` back to the gate's `"household"` at
 * its own boundary, so this stays on the UI side of that seam.
 *
 * This is the INVERSE of `parseSpaceValue` / `checkSpaceAccess`, which read a
 * wire token into a department. Both directions live here on purpose: the
 * HOUSEHOLD alias rule (WARP-1898) was duplicated verbatim in two routers, and a
 * change to it had to be applied twice by hand with nothing enforcing the
 * second copy.
 */
export async function departmentSpaceToken(
  prisma: PrismaClient,
  departmentId: string,
): Promise<string> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { kind: true },
  });
  return dept?.kind === "HOUSEHOLD" ? "shared" : `dept:${departmentId}`;
}
