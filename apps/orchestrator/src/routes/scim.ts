/**
 * WARP (SCIM directory sync) — SCIM 2.0 server (Okta provisions users/groups
 * to the box). Mounted on the PUBLIC router segment (Okta has no human
 * session) BEHIND its own dedicated bearer guard (scimAuthMiddleware) — this
 * surface never touches authMiddleware or a user cookie.
 *
 *   POST   /scim/v2/Users            create        (idempotent on Okta retry)
 *   GET    /scim/v2/Users?filter=…    list / userName-eq existence probe
 *   GET    /scim/v2/Users/:id         read one
 *   PUT    /scim/v2/Users/:id         replace       (active toggle)
 *   PATCH  /scim/v2/Users/:id         partial       (Okta's active:false op)
 *   DELETE /scim/v2/Users/:id         de-provision  → SOFT-deactivate, no delete
 *   POST   /scim/v2/Groups           group + role mapping
 *
 * The route is thin: parsing/serialization lives in scim-resource.ts, all DB
 * writes in scim.service.ts. Errors are thrown as ScimError and rendered once
 * by a shared catch into the SCIM Error envelope (application/scim+json).
 */
import { Router, type Request, type Response } from "express";
import { readUserEmail } from "../services/user-directory.service.js";

import { scimAuthMiddleware } from "../middleware/scim-auth.js";
import {
  toScimUser,
  toScimListResponse,
  parseUserNameEqFilter,
  parseScimUser,
  ScimError,
  SCIM_CONTENT_TYPE,
  SCIM_GROUP_SCHEMA,
  type LocalUserForScim,
} from "../services/scim-resource.js";
import {
  provisionUser,
  findUserById,
  findUserByUserName,
  setUserActive,
  deactivateUser,
  replaceUser,
  provisionGroup,
} from "../services/scim.service.js";
import { RoleMutationRefusedError } from "../services/role-mutation-guard.service.js";
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "../services/activity.singleton.js";

const logger = createLogger("scim-route");

type PrismaClient = import("@prisma/client").PrismaClient;

/** Narrow a Prisma User row to the SCIM-render shape. */
function asScimSource(u: {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  directoryStatus: string;
  createdAt: Date;
  updatedAt: Date;
}): LocalUserForScim {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    // WARP-233: SCIM resources surface the plaintext (userName/emails[]) —
    // decrypt the at-rest dcv1 blob; pre-backfill plaintext passes through.
    email: readUserEmail(u.email),
    role: u.role,
    directoryStatus: u.directoryStatus === "DEACTIVATED" ? "DEACTIVATED" : "ACTIVE",
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/**
 * Extract an `active` boolean from a SCIM PATCH PatchOp body. Handles the two
 * shapes Okta + SCIM clients send for the deactivate/reactivate op:
 *   - { op:"replace", path:"active", value:false }
 *   - { op:"replace", value:{ active:false } }
 * Returns undefined when no Operation touches `active`.
 */
function activeFromPatch(body: unknown): boolean | undefined {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops)) return undefined;
  let result: boolean | undefined;
  for (const op of ops) {
    const o = op as { op?: string; path?: string; value?: unknown };
    if (typeof o.path === "string" && o.path.toLowerCase() === "active") {
      if (typeof o.value === "boolean") result = o.value;
    } else if (o.value && typeof o.value === "object" && "active" in (o.value as object)) {
      const v = (o.value as { active?: unknown }).active;
      if (typeof v === "boolean") result = v;
    }
  }
  return result;
}

export function createScimRouter(prisma?: PrismaClient): Router {
  const router = Router();

  // Dedicated SCIM bearer guard on the whole surface — never authMiddleware.
  router.use("/scim/v2", scimAuthMiddleware);

  /** Shared async wrapper: renders a thrown ScimError into the SCIM Error
   *  envelope; anything else 500s as a SCIM error WITHOUT leaking internals. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        if (!prisma) throw new ScimError(500, "SCIM is not available");
        await fn(req, res);
      } catch (err) {
        if (err instanceof ScimError) {
          res.status(err.status).type(SCIM_CONTENT_TYPE).json(err.toScim());
          return;
        }
        // WARP-2016: a rail refusal from the role-mutation guard renders as
        // a SCIM Error envelope carrying the rail's stable machine-readable
        // code in `scimType` — 403 OWNER_IMMUTABLE, 409
        // LAST_OPERATOR_INVARIANT (two different rails, two different
        // codes), 409 CONCURRENT_MUTATION for a lost race. Both refusal
        // statuses are terminal for Okta, so the refusal cannot 4xx-loop its
        // retry into a wedge; logged at warn with the code, the same posture
        // as the per-member group-mapping refusals (scim.service.ts) —
        // never swallowed silently, never a 500.
        if (err instanceof RoleMutationRefusedError) {
          logger.warn(
            { code: err.code, method: req.method, path: req.path },
            "SCIM mutation refused by the role-mutation guard; nothing was applied",
          );
          res
            .status(err.status)
            .type(SCIM_CONTENT_TYPE)
            .json(new ScimError(err.status, err.message, err.code).toScim());
          return;
        }
        logger.error({ err: (err as Error).message }, "SCIM request failed");
        res.status(500).type(SCIM_CONTENT_TYPE).json(new ScimError(500, "Internal error").toScim());
      }
    };

  // ── Users ──

  router.post(
    "/scim/v2/Users",
    handle(async (req, res) => {
      const parsed = parseScimUser(req.body);
      const { user, created } = await provisionUser(prisma!, parsed);
      // WARP-237: SCIM callers are IdP service principals, never humans →
      // actor system; provenance stays in refs.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "users",
        what: created ? "SCIM user provisioned" : "SCIM user updated",
        sub: user.username,
        refs: { via: "scim", userId: user.id },
        actor: { type: "system", id: null },
      });
      res
        .status(created ? 201 : 200)
        .type(SCIM_CONTENT_TYPE)
        .location(`/scim/v2/Users/${user.id}`)
        .json(toScimUser(asScimSource(user)));
    }),
  );

  router.get(
    "/scim/v2/Users",
    handle(async (req, res) => {
      const filter = typeof req.query.filter === "string" ? req.query.filter : undefined;
      // The only supported filter is `userName eq "..."` (Okta's existence
      // probe). An unsupported/absent filter returns an empty ListResponse
      // rather than a 400 that would wedge Okta's reconciliation.
      const email = parseUserNameEqFilter(filter);
      if (!email) {
        res.status(200).type(SCIM_CONTENT_TYPE).json(toScimListResponse([], 0, 1));
        return;
      }
      const user = await findUserByUserName(prisma!, email);
      const resources = user ? [toScimUser(asScimSource(user))] : [];
      res.status(200).type(SCIM_CONTENT_TYPE).json(toScimListResponse(resources, resources.length, 1));
    }),
  );

  router.get(
    "/scim/v2/Users/:id",
    handle(async (req, res) => {
      const user = await findUserById(prisma!, req.params.id);
      if (!user) throw ScimError.notFound("User not found");
      res.status(200).type(SCIM_CONTENT_TYPE).json(toScimUser(asScimSource(user)));
    }),
  );

  // PUT = full replace. Okta sends the whole resource; we key by the path id
  // and apply displayName + active. (userName/email is the immutable login
  // key — we do not re-key an existing row here.) WARP-2016: the active flip
  // routes through the SAME guarded funnel as PATCH/DELETE — this verb used
  // to perform its own bare `prisma.user.update` on `directoryStatus`,
  // bypassing scim.service.ts and every disable rail.
  router.put(
    "/scim/v2/Users/:id",
    handle(async (req, res) => {
      const existing = await findUserById(prisma!, req.params.id);
      if (!existing) throw ScimError.notFound("User not found");
      const parsed = parseScimUser(req.body);
      const updated = await replaceUser(prisma!, existing.id, parsed);
      if (!updated) throw ScimError.notFound("User not found");
      // WARP-237: SCIM full-replace is an admin-directory mutation.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "users",
        what: "SCIM user updated",
        sub: updated.username,
        refs: { via: "scim", userId: updated.id, active: parsed.active },
        actor: { type: "system", id: null },
      });
      res.status(200).type(SCIM_CONTENT_TYPE).json(toScimUser(asScimSource(updated)));
    }),
  );

  // PATCH = partial. The op Okta uses for (de)activation is replace on
  // `active`; we honor that and ignore other ops (we don't support arbitrary
  // attribute patches — out of scope per the AC).
  router.patch(
    "/scim/v2/Users/:id",
    handle(async (req, res) => {
      const existing = await findUserById(prisma!, req.params.id);
      if (!existing) throw ScimError.notFound("User not found");
      const active = activeFromPatch(req.body);
      if (active === undefined) {
        // Nothing we act on — return the current resource unchanged (a no-op
        // PATCH is not an error in SCIM).
        res.status(200).type(SCIM_CONTENT_TYPE).json(toScimUser(asScimSource(existing)));
        return;
      }
      const updated = await setUserActive(prisma!, existing.id, active);
      // WARP-237: the op Okta uses here is (de)activation — a privileged
      // directory mutation. Deactivation is a warn.
      await recordActivity({
        kind: "auth",
        severity: active ? "ok" : "warn",
        sourceIcon: "users",
        what: active ? "SCIM user updated" : "SCIM user deactivated",
        sub: (updated ?? existing).username,
        refs: { via: "scim", userId: existing.id, active },
        actor: { type: "system", id: null },
      });
      res.status(200).type(SCIM_CONTENT_TYPE).json(toScimUser(asScimSource(updated ?? existing)));
    }),
  );

  // DELETE de-provisions. Per the directory model this is a SOFT deactivate
  // (architecture-guard rule 10), NOT a row delete — Okta may re-activate the
  // same person later and we must preserve User.id + audit history.
  router.delete(
    "/scim/v2/Users/:id",
    handle(async (req, res) => {
      const result = await deactivateUser(prisma!, req.params.id);
      if (!result) throw ScimError.notFound("User not found");
      // WARP-237: SCIM de-provision (soft deactivate) — privileged
      // directory mutation, warn severity.
      await recordActivity({
        kind: "auth",
        severity: "warn",
        sourceIcon: "users",
        what: "SCIM user deactivated",
        sub: result.username,
        refs: { via: "scim", userId: result.id, active: false },
        actor: { type: "system", id: null },
      });
      res.status(204).end();
    }),
  );

  // ── Groups ──
  // Minimal: upsert the group (role mapping) and apply its mapped role to the
  // listed members. Membership detail / the gated Team UI is explicitly NOT
  // built here (AC).
  router.post(
    "/scim/v2/Groups",
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (displayName.length === 0) {
        throw ScimError.badRequest("displayName is required for a Group");
      }
      const externalId =
        typeof body.externalId === "string" && body.externalId.length > 0 ? body.externalId : undefined;
      const members = Array.isArray(body.members) ? body.members : [];
      const memberUserIds = members
        .map((m) => (m as { value?: unknown }).value)
        .filter((v): v is string => typeof v === "string");

      const group = await provisionGroup(prisma!, { displayName, externalId, memberUserIds });
      res
        .status(201)
        .type(SCIM_CONTENT_TYPE)
        .location(`/scim/v2/Groups/${group.id}`)
        .json({
          schemas: [SCIM_GROUP_SCHEMA],
          id: group.id,
          displayName: group.displayName,
          meta: { resourceType: "Group", location: `/scim/v2/Groups/${group.id}` },
        });
    }),
  );

  return router;
}
