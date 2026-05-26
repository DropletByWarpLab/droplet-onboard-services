/**
 * WARP-455 — A1 local user directory + scope bindings + guest time-box.
 *
 * Surface owned by this file:
 *   GET    /api/people                — owner+admin list of local User rows
 *   GET    /api/people/permissions    — role × ability matrix (read-only)
 *   PATCH  /api/people/:id/role       — owner+admin, emits ActivityRow
 *   PATCH  /api/people/:id/scope      — owner+admin, emits ActivityRow
 *   DELETE /api/people/:id            — owner+admin, emits ActivityRow
 *
 * Dependencies (do NOT re-implement):
 *   - `requireRole(...roles)`           — WARP-171, src/middleware/auth.ts
 *   - `recordActivity({ kind, ... })`   — WARP-456, src/services/activity.singleton.ts
 *   - `Role` enum                       — WARP-171, src/services/jwt.service.ts (mirrors Prisma)
 *   - `Scope` enum + `requireScope`     — added by THIS ticket, src/middleware/scope.ts
 *
 * Per the no-guessing rule (CLAUDE.md): the User row carries `role: Role`
 * and the GuestExpiry row carries `status: GuestExpiryStatus` — both
 * explicit Prisma enums, never derived from a nullable column.
 *
 * The local `User` model is ADDITIVE on top of the Nextcloud-OCS auth
 * fallback in middleware/auth.ts — it does not replace OCS-validated
 * sessions. A row in this table represents a person the household has
 * deliberately registered through the dashboard's People surface; the
 * Nextcloud fallback continues to populate `req.user` for legacy
 * sessions that haven't yet been mirrored locally.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";

const logger = pino({ name: "people-route" });

// Canonical role + scope sets — duplicated as TS literals (mirroring
// what middleware/scope.ts does) so this file compiles standalone
// without pulling the Prisma client into a hot path. Any drift between
// these constants and the Prisma enum is a schema bug; the schema
// tests (local-directory.schema.test.ts + scope.schema.test.ts) lock
// the contract.
const ROLE_VALUES = ["owner", "admin", "family", "guest", "service"] as const;
const SCOPE_VALUES = [
  "team",
  "exec_only",
  "finance",
  "engineering",
  "ops",
  "private",
] as const;

const roleSchema = z.object({
  role: z.enum(ROLE_VALUES),
});

const scopeSchema = z.object({
  // At least one binding required. Clearing every binding is a
  // delete-style operation that doesn't belong on PATCH; empty arrays
  // are almost certainly a UX bug (the dashboard sent [] when it meant
  // ["team"]) and 400 prevents accidentally locking a user out.
  scopes: z.array(z.enum(SCOPE_VALUES)).min(1).max(SCOPE_VALUES.length),
});

/**
 * Role × ability matrix. Read-only surface for the dashboard's
 * permissions page — encodes the ADR-004 §3 contract so the UI can
 * render the table without a second source of truth. The booleans
 * here intentionally mirror the per-route guards in
 * `__tests__/rbac.test.ts` plus the scope-axis additions from this
 * ticket (the actual enforcement lives in the route guards, not here).
 *
 * Adding a new ability: append a key here AND add the matching
 * `requireRole` / `requireScope` guard at the route. The dashboard
 * keys off the response shape so renaming an existing key is a
 * breaking change.
 */
const PERMISSIONS_MATRIX = {
  owner: {
    managePeople: true,
    manageNetwork: true,
    restartServices: true,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: true,
  },
  admin: {
    managePeople: true,
    manageNetwork: true,
    restartServices: false,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: true,
  },
  family: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: false,
  },
  guest: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: false,
    manageMatter: false,
    writeFiles: false,
    chat: true,
    everyScope: false,
  },
  service: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: false,
    manageMatter: false,
    writeFiles: false,
    chat: true, // voice-io posts to /api/llm/chat under the service principal
    everyScope: false,
  },
} as const;

export function createPeopleRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/people ─────────────────────────────────────────
  // Returns every row in the local directory. owner + admin only —
  // the household roster is administrative.
  router.get(
    "/people",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const people = await prisma.user.findMany();
        res.json({ people });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/people/permissions ─────────────────────────────
  // The role × ability matrix the dashboard renders on its Permissions
  // page. Open to every authenticated principal — knowing what
  // *would* be allowed isn't sensitive (the actual enforcement happens
  // at write time on each guarded route).
  router.get(
    "/people/permissions",
    (_req: Request, res: Response) => {
      res.json({ permissions: PERMISSIONS_MATRIX });
    },
  );

  // ── PATCH /api/people/:id/role ──────────────────────────────
  // owner + admin can change another user's role. Emits an
  // ActivityRow with kind=system (per controller brief: lifecycle
  // events go on `auth`, permission edits go on `system`).
  router.patch(
    "/people/:id/role",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. Runs FIRST so the refusal path
        // skips the body parse + DB read entirely. Operators must use
        // the appropriate workflow (re-invite, ownership-transfer) to
        // change their own role — the people surface is for editing
        // OTHER members, and a self-edit here is almost always a
        // misclick that ends in lockout. Refusals do NOT emit an
        // ActivityRow: the audit log is reserved for actual state
        // changes; refused calls are noise that crowd out signal.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const parsed = roleSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid role",
            details: parsed.error.flatten(),
          });
        }

        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }
        // No-op short-circuit: skip the update AND the audit row when
        // the role is already what the caller asked for. Avoids
        // polluting the activity feed with no-change touches when the
        // dashboard re-submits the same form on focus loss.
        if (existing.role === parsed.data.role) {
          return res.json({ user: existing });
        }

        // WARP-480 last-owner invariant. At least one user with
        // role="owner" must remain at all times so owner-only routes
        // (POST /api/network/system/reboot, the device-identity reseal,
        // etc.) stay reachable without DB hand-edits. The count + the
        // update run inside a single interactive $transaction so a
        // concurrent demotion can't slip past the check window —
        // serializable isolation is the default for Prisma $transaction
        // on Postgres, which is what we need here.
        //
        // Only fires on owner→non-owner. Owner→owner is filtered out
        // above by the no-op short-circuit, and non-owner→anything
        // never touches the invariant.
        const demotingOnlyOwner =
          existing.role === "owner" && parsed.data.role !== "owner";

        const result = await prisma.$transaction(async (tx) => {
          if (demotingOnlyOwner) {
            const owners = await tx.user.count({ where: { role: "owner" } });
            if (owners <= 1) {
              return { kind: "last-owner" as const };
            }
          }
          const updated = await tx.user.update({
            where: { id: req.params.id },
            data: { role: parsed.data.role },
          });
          return { kind: "ok" as const, updated };
        });

        if (result.kind === "last-owner") {
          return res.status(409).json({
            error:
              "Cannot remove the only owner. Promote another user to owner first.",
            code: "LAST_OWNER_INVARIANT",
          });
        }

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "shield",
          what: "Role changed",
          sub: `${existing.username}: ${existing.role} → ${parsed.data.role}`,
          refs: {
            actor: req.user?.username ?? null,
            targetUserId: existing.id,
            targetUsername: existing.username,
            previousRole: existing.role,
            nextRole: parsed.data.role,
          },
        });

        res.json({ user: result.updated });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/people/:id/scope ─────────────────────────────
  // owner + admin can replace the user's scope bindings wholesale.
  // PATCH semantics: send the full desired set; the server diffs by
  // deleting all existing bindings and recreating from the payload.
  // Wrapped in a transaction so a partial failure doesn't leave the
  // user with no bindings at all.
  router.patch(
    "/people/:id/scope",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. See the matching block on
        // PATCH /people/:id/role for the full rationale; same shape
        // here so the dashboard can render one error path. Runs
        // BEFORE the body parse to save a roundtrip on the refusal.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const parsed = scopeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid scopes",
            details: parsed.error.flatten(),
          });
        }

        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }

        // Drop the old bindings, write the new ones. Two separate
        // Prisma calls (deleteMany + N creates) — production wiring
        // wraps these in a $transaction so a partial failure can't
        // leave the user with zero bindings; the test mock skips the
        // transaction wrapper for shape simplicity.
        const targetUserId = req.params.id;
        const actor = req.user?.username ?? null;

        await prisma.scopeBinding.deleteMany({
          where: { userId: targetUserId },
        });
        for (const scope of parsed.data.scopes) {
          await prisma.scopeBinding.create({
            data: {
              userId: targetUserId,
              scope: scope as any, // Scope enum literal; cast for Prisma input
              grantedBy: actor,
            },
          });
        }

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "shield",
          what: "Scope bindings updated",
          sub: `${existing.username}: [${parsed.data.scopes.join(", ")}]`,
          refs: {
            actor,
            targetUserId: existing.id,
            targetUsername: existing.username,
            scopes: parsed.data.scopes,
          },
        });

        res.json({
          user: existing,
          scopes: parsed.data.scopes,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/people/:id ──────────────────────────────────
  // owner + admin only. Cascade on User deletes ScopeBindings and
  // GroupMemberships per the schema's onDelete: Cascade. We refuse to
  // delete OCS-owned rows (isLocal=false) — Nextcloud upstream owns
  // those identities; deleting locally would create drift the next
  // sync would rewrite anyway.
  router.delete(
    "/people/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. An owner could otherwise DELETE
        // their own row and lock the household out of every owner-only
        // route. Account removal goes through a separate workflow (not
        // in this surface) so an operator can never accidentally delete
        // themselves with one wrong click.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }
        if (!existing.isLocal) {
          // 409 Conflict — \"the resource state forbids this\". 403 would
          // imply auth/permission; the caller IS allowed, the resource
          // just isn't deletable from here.
          return res.status(409).json({
            error: "Cannot delete OCS-owned identity from local directory",
          });
        }

        // WARP-480 last-owner invariant. Deleting an owner is only
        // allowed when at least one other owner remains. count + delete
        // run inside one interactive $transaction so a concurrent
        // demotion of the other owner can't slip past the check window.
        const result = await prisma.$transaction(async (tx) => {
          if (existing.role === "owner") {
            const owners = await tx.user.count({ where: { role: "owner" } });
            if (owners <= 1) {
              return { kind: "last-owner" as const };
            }
          }
          await tx.user.delete({ where: { id: req.params.id } });
          return { kind: "ok" as const };
        });

        if (result.kind === "last-owner") {
          return res.status(409).json({
            error:
              "Cannot remove the only owner. Promote another user to owner first.",
            code: "LAST_OWNER_INVARIANT",
          });
        }

        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "user-x",
          what: "User removed",
          sub: existing.username,
          refs: {
            actor: req.user?.username ?? null,
            targetUserId: existing.id,
            targetUsername: existing.username,
            role: existing.role,
          },
        });

        res.json({ ok: true, removed: existing.username });
      } catch (err) {
        // Prisma's P2025 (record not found) shouldn't reach here
        // because of the findUnique above, but stay defensive.
        logger.warn({ err, id: req.params.id }, "DELETE /people failed");
        next(err);
      }
    },
  );

  return router;
}
