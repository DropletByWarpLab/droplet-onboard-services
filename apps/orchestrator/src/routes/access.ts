/**
 * WARP-1527 / ADR-032 §5 (RBAC v2 T3) — the Access & Roles admin surface.
 *
 * Surface owned by this file (all owner+admin, people.ts conventions:
 * UUIDs everywhere, BigInt as strings, RoleMutationRefusedError mapped to
 * its status, every mutation Activity-audited kind="auth"):
 *
 *   GET    /api/access/roles             — { roles: AccessRole[] }
 *   POST   /api/access/roles             — create; { sourceRoleId } duplicates
 *   GET    /api/access/roles/:id         — { role }
 *   PATCH  /api/access/roles/:id         — update / archive ({ state })
 *   DELETE /api/access/roles/:id         — blocked while in use (reassign first)
 *   POST   /api/access/roles/:id/assign  — { userIds: [] } → { syncState }
 *
 * Server-authoritative invariants (the dashboard pre-clamps for honest UI
 * but is never trusted):
 *   - slug is DERIVED server-side from the name at create time and stays
 *     stable across renames (it's an identifier, not a display field);
 *   - feature-grant levels re-clamp to the §9 catalog ceiling of the
 *     role's startingPoint (access-catalog.service);
 *   - connector read_write grants clamp to read on non-admin starting
 *     points, and Guest-based roles hold NO connector grant at all —
 *     a guest sits below O-2's family-and-up read floor, so the row could
 *     never take effect (O-2 floor honesty; WARP-1578);
 *   - mayOperateLocks is forced false without a smart_home feature grant;
 *   - startingPoint ∈ {admin, family, guest} via the T2 guard vocabulary —
 *     never owner/service;
 *   - a startingPoint change re-tiers every member IN THE SAME TRANSACTION
 *     (User.role = startingPoint is what keeps the ADR-004 enum floor
 *     authoritative), running the T2 rails per member;
 *   - deleting a role is refused while ANY member or PENDING invite
 *     references it (reassign-first payload lists both); NON-pending
 *     invite rows (accepted/revoked/expired — retained state) get their
 *     accessRoleId released inside the delete transaction so the
 *     onDelete: Restrict FK can clear. The FK stays the in-DB backstop
 *     for check→delete races (P2003 → the same 409).
 *
 * Usage-default reconcile decision (carried WARP-1527 obligation): a SET or
 * CHANGED storage default on a role with members kicks the department
 * reconciler (usage-policy pass 2 pushes the role default to every
 * role-managed member — the T7 machinery, debounced seconds instead of the
 * 5-minute tick). A CLEARED default deliberately does NOT push: null means
 * "box default = unmanaged" (T7's reviewed semantics — never an implicit
 * push of "none"/unlimited), so the response surfaces
 * `retainedQuotaCount` — how many members keep their current NC quota
 * until edited — for the UI's honest confirm line.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { ModuleId, PrismaClient, Prisma } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  RoleMutationRefusedError,
  SERIALIZABLE_TX,
  ASSIGNABLE_ROLES,
  type AssignableRole,
  assertAssignableForCreate,
  assertRoleChangeAllowed,
  assertRoleChangeInvariantsTx,
  runRoleChangePostEffects,
} from "../services/role-mutation-guard.service.js";
import { revokeAllSessions } from "../services/session.service.js";
import { kickReconcile } from "../services/department-reconciler.service.js";
import {
  GATEABLE_MODULE_IDS,
  GRANTABLE_TOOL_DOMAINS,
  clampConnectorLevel,
  clampLevel,
  type ConnectorLevel,
  type FeatureLevel,
  type GateableModuleId,
} from "../services/access-catalog.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("access-route");

// ── zod (carried obligation 1: validators land HERE with the routes) ──

const featureGrantSchema = z.object({
  moduleId: z.enum(GATEABLE_MODULE_IDS as unknown as [GateableModuleId, ...GateableModuleId[]]),
  level: z.enum(["view", "act", "manage"]),
});

const toolGrantSchema = z.object({
  // Validated against the tools-core catalog at write time (schema comment
  // on AccessRoleToolGrant); `erp` is excluded — connector reach is the
  // connectors axis, never a tool grant.
  domain: z.enum(GRANTABLE_TOOL_DOMAINS as [string, ...string[]]),
  level: z.enum(["view", "use"]),
});

const connectorGrantSchema = z.object({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase provider slug"),
  level: z.enum(["read", "read_write"]),
});

const uniqueBy = <T>(key: (item: T) => string) => (arr: T[]) =>
  new Set(arr.map(key)).size === arr.length;

/** The T8 AccessRolePayload (§2 flattened). BigInt stays a decimal string
 *  on the wire (WARP-455 boundary rule) and parses to a real bigint before
 *  it reaches Prisma. */
const rolePayloadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable(),
  // Reuses the T2 guard vocabulary — never owner/service (§6.2).
  startingPoint: z.enum(ASSIGNABLE_ROLES),
  storageQuotaBytes: z.string().regex(/^\d+$/).nullable(),
  maxUploadSizeMb: z.number().int().positive().max(1_000_000).nullable(),
  llmDailyMessageCap: z.number().int().positive().max(1_000_000).nullable(),
  cloudModelsAllowed: z.boolean(),
  mayOperateLocks: z.boolean(),
  featureGrants: z
    .array(featureGrantSchema)
    .max(GATEABLE_MODULE_IDS.length)
    .refine(uniqueBy((g) => g.moduleId), { message: "Duplicate feature grants" }),
  toolGrants: z
    .array(toolGrantSchema)
    .max(GRANTABLE_TOOL_DOMAINS.length)
    .refine(uniqueBy((g) => g.domain), { message: "Duplicate tool grants" }),
  connectorGrants: z
    .array(connectorGrantSchema)
    .max(16)
    .refine(uniqueBy((g) => g.provider), { message: "Duplicate connector grants" }),
});

const duplicateSchema = z.object({ sourceRoleId: z.string().min(1).max(128) });

const rolePatchSchema = rolePayloadSchema
  .partial()
  .extend({ state: z.enum(["active", "archived"]).optional() })
  .refine((body) => Object.keys(body).length > 0, { message: "Empty patch" });

const assignSchema = z.object({
  userIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(200)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: "Duplicate userIds",
    }),
});

// ── normalization + serialization ─────────────────────────────────

interface NormalizedGrants {
  featureGrants: Array<{ moduleId: ModuleId; level: FeatureLevel }>;
  toolGrants: Array<{ domain: string; level: "view" | "use" }>;
  connectorGrants: Array<{ provider: string; level: ConnectorLevel }>;
  mayOperateLocks: boolean;
}

/** The authoritative server re-clamp (§9 ceiling, O-2 connector floor,
 *  locks-without-smart_home). Pure — used by create, duplicate, and the
 *  PATCH re-floor path alike. */
function normalizeGrants(args: {
  startingPoint: AssignableRole;
  featureGrants: Array<{ moduleId: GateableModuleId; level: FeatureLevel }>;
  toolGrants: Array<{ domain: string; level: "view" | "use" }>;
  connectorGrants: Array<{ provider: string; level: ConnectorLevel }>;
  mayOperateLocks: boolean;
}): NormalizedGrants {
  const featureGrants = args.featureGrants.map((g) => ({
    moduleId: g.moduleId as ModuleId,
    level: clampLevel(args.startingPoint, g.moduleId, g.level),
  }));
  // O-2's connector floors, both of them, from the one authoritative helper:
  // read_write only on Admin-based roles, and (WARP-1578) NO grant at all on
  // Guest-based roles — a guest sits below O-2's family-and-up read floor, so
  // the row could never take effect and storing it would let an operator save
  // a setting that silently does nothing.
  const connectorGrants = args.connectorGrants.flatMap((g) => {
    const level = clampConnectorLevel(args.startingPoint, g.level);
    return level === null ? [] : [{ provider: g.provider, level }];
  });
  const smartHomeOn = featureGrants.some((g) => g.moduleId === "smart_home");
  return {
    featureGrants,
    toolGrants: args.toolGrants.map((g) => ({ ...g })),
    connectorGrants,
    mayOperateLocks: args.mayOperateLocks && smartHomeOn,
  };
}

type RoleWithMeta = Prisma.AccessRoleGetPayload<{
  include: {
    featureGrants: true;
    toolGrants: true;
    connectorGrants: true;
    _count: { select: { users: true } };
  };
}>;

const ROLE_INCLUDE = {
  featureGrants: true,
  toolGrants: true,
  connectorGrants: true,
  _count: { select: { users: true } },
} as const;

/** The T8 AccessRole wire shape — BigInt string-encoded, peopleCount from
 *  the relation count, grants flattened to their wire pairs. */
function serializeAccessRole(row: RoleWithMeta) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    startingPoint: row.startingPoint,
    state: row.state,
    storageQuotaBytes: row.storageQuotaBytes?.toString() ?? null,
    maxUploadSizeMb: row.maxUploadSizeMb ?? null,
    llmDailyMessageCap: row.llmDailyMessageCap ?? null,
    cloudModelsAllowed: row.cloudModelsAllowed,
    mayOperateLocks: row.mayOperateLocks,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    peopleCount: row._count.users,
    featureGrants: row.featureGrants.map((g) => ({ moduleId: g.moduleId, level: g.level })),
    toolGrants: row.toolGrants.map((g) => ({ domain: g.domain, level: g.level })),
    connectorGrants: row.connectorGrants.map((g) => ({ provider: g.provider, level: g.level })),
  };
}

/** Server-owned slug derivation (carried obligation 1) — lowercase, dashed,
 *  uniquified against existing slugs with a numeric suffix. */
export function slugifyRoleName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "role";
}

async function deriveUniqueSlug(
  tx: Pick<PrismaClient, "accessRole">,
  name: string,
): Promise<string> {
  const base = slugifyRoleName(name);
  const taken = new Set(
    (
      await tx.accessRole.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Write a role + its grant rows inside `tx`; returns the new id. */
async function createRoleTx(
  tx: PrismaClient,
  args: {
    name: string;
    description: string | null;
    startingPoint: AssignableRole;
    storageQuotaBytes: bigint | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
    cloudModelsAllowed: boolean;
    grants: NormalizedGrants;
    createdBy: string;
  },
): Promise<string> {
  const slug = await deriveUniqueSlug(tx, args.name);
  const role = await tx.accessRole.create({
    data: {
      name: args.name,
      slug,
      description: args.description,
      startingPoint: args.startingPoint,
      storageQuotaBytes: args.storageQuotaBytes,
      maxUploadSizeMb: args.maxUploadSizeMb,
      llmDailyMessageCap: args.llmDailyMessageCap,
      cloudModelsAllowed: args.cloudModelsAllowed,
      mayOperateLocks: args.grants.mayOperateLocks,
      createdBy: args.createdBy,
    },
  });
  if (args.grants.featureGrants.length > 0) {
    await tx.accessRoleFeatureGrant.createMany({
      data: args.grants.featureGrants.map((g) => ({ roleId: role.id, ...g })),
    });
  }
  if (args.grants.toolGrants.length > 0) {
    await tx.accessRoleToolGrant.createMany({
      data: args.grants.toolGrants.map((g) => ({ roleId: role.id, ...g })),
    });
  }
  if (args.grants.connectorGrants.length > 0) {
    await tx.accessRoleConnectorGrant.createMany({
      data: args.grants.connectorGrants.map((g) => ({ roleId: role.id, ...g })),
    });
  }
  return role.id;
}

function isForeignKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2003";
}

/**
 * Route-level precondition failure raised from INSIDE a transaction (404 /
 * 409 outcomes that must be decided against transactionally-consistent
 * reads — review B2). Throwing rolls the transaction back; the route catch
 * maps `status`/`body` exactly like RoleMutationRefusedError. Kept local:
 * these are HTTP shapes, not guard rails.
 */
class AccessPreconditionError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : "Precondition failed");
    this.name = "AccessPreconditionError";
  }
}

const ROLE_IN_USE = {
  error:
    "This role is still assigned. Move its people (and pending invites) to another role first.",
  code: "ACCESS_ROLE_IN_USE",
} as const;

export function createAccessRouter(prisma: PrismaClient): Router {
  const router = Router();

  const loadRole = (id: string) =>
    prisma.accessRole.findUnique({ where: { id }, include: ROLE_INCLUDE });

  // ── GET /api/access/roles ───────────────────────────────────
  router.get(
    "/access/roles",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const rows = (await prisma.accessRole.findMany({
          include: ROLE_INCLUDE,
          orderBy: { name: "asc" },
        })) as RoleWithMeta[];
        res.json({ roles: rows.map(serializeAccessRole) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/access/roles/:id ───────────────────────────────
  router.get(
    "/access/roles/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = await loadRole(req.params.id);
        if (!row) return res.status(404).json({ error: "Role not found" });
        res.json({ role: serializeAccessRole(row) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/access/roles (create | duplicate) ─────────────
  router.post(
    "/access/roles",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actorId = req.user?.id ?? "unknown";

        // Duplicate = POST { sourceRoleId } — the server copies the grant
        // set and derives a fresh name/slug (§5).
        const isDuplicate =
          typeof (req.body as { sourceRoleId?: unknown })?.sourceRoleId === "string";

        let name: string;
        let description: string | null;
        let startingPoint: AssignableRole;
        let storageQuotaBytes: bigint | null;
        let maxUploadSizeMb: number | null;
        let llmDailyMessageCap: number | null;
        let cloudModelsAllowed: boolean;
        let grants: NormalizedGrants;
        let duplicatedFrom: string | null = null;

        if (isDuplicate) {
          const parsed = duplicateSchema.safeParse(req.body);
          if (!parsed.success) {
            return res
              .status(400)
              .json({ error: "Invalid request", details: parsed.error.flatten() });
          }
          const source = await loadRole(parsed.data.sourceRoleId);
          if (!source) return res.status(404).json({ error: "Role not found" });
          name = `${source.name} (copy)`;
          description = source.description ?? null;
          startingPoint = source.startingPoint as AssignableRole;
          storageQuotaBytes = source.storageQuotaBytes;
          maxUploadSizeMb = source.maxUploadSizeMb;
          llmDailyMessageCap = source.llmDailyMessageCap;
          cloudModelsAllowed = source.cloudModelsAllowed;
          duplicatedFrom = source.id;
          grants = normalizeGrants({
            startingPoint,
            featureGrants: source.featureGrants.map((g) => ({
              moduleId: g.moduleId as GateableModuleId,
              level: g.level as FeatureLevel,
            })),
            toolGrants: source.toolGrants.map((g) => ({
              domain: g.domain,
              level: g.level as "view" | "use",
            })),
            connectorGrants: source.connectorGrants.map((g) => ({
              provider: g.provider,
              level: g.level as ConnectorLevel,
            })),
            mayOperateLocks: source.mayOperateLocks,
          });
        } else {
          const parsed = rolePayloadSchema.safeParse(req.body);
          if (!parsed.success) {
            return res
              .status(400)
              .json({ error: "Invalid request", details: parsed.error.flatten() });
          }
          // Rails 3 + 7: authoring an Admin-based role is itself rank-capped
          // (an admin may author admin-based roles — equal rank allowed).
          assertAssignableForCreate({
            actorRole: req.user?.role,
            requestedRole: parsed.data.startingPoint,
            rankMessage: "You cannot create a role above your own rank",
          });
          name = parsed.data.name;
          description = parsed.data.description;
          startingPoint = parsed.data.startingPoint;
          storageQuotaBytes =
            parsed.data.storageQuotaBytes === null ? null : BigInt(parsed.data.storageQuotaBytes);
          maxUploadSizeMb = parsed.data.maxUploadSizeMb;
          llmDailyMessageCap = parsed.data.llmDailyMessageCap;
          cloudModelsAllowed = parsed.data.cloudModelsAllowed;
          grants = normalizeGrants({
            startingPoint,
            featureGrants: parsed.data.featureGrants,
            toolGrants: parsed.data.toolGrants,
            connectorGrants: parsed.data.connectorGrants,
            mayOperateLocks: parsed.data.mayOperateLocks,
          });
        }

        // SERIALIZABLE_TX explicitly (WARP-1526: the isolation level is passed
        // at every call site, never defaulted). Needed on its own merits here:
        // deriveUniqueSlug is a RANGE READ (`slug startsWith base`) followed by
        // an insert into that range, so under READ COMMITTED two concurrent
        // creates of the same name both read the same taken-set and race for
        // one slug — the @unique then 500s the loser instead of handing it
        // "-3". Under SERIALIZABLE the loser aborts cleanly (P2034).
        const roleId = await prisma.$transaction(
          async (tx) =>
            createRoleTx(tx as PrismaClient, {
              name,
              description,
              startingPoint,
              storageQuotaBytes,
              maxUploadSizeMb,
              llmDailyMessageCap,
              cloudModelsAllowed,
              grants,
              createdBy: actorId,
            }),
          SERIALIZABLE_TX,
        );

        const created = (await loadRole(roleId)) as RoleWithMeta;
        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "shield",
          what: "Access role created",
          sub: duplicatedFrom ? `${created.name} (duplicate)` : created.name,
          refs: {
            actor: req.user?.username ?? null,
            roleId: created.id,
            roleName: created.name,
            startingPoint,
            duplicatedFrom,
          },
          actor: actorFromRequest(req),
        });

        // No members yet — nothing NC-affecting to converge.
        res.json({ role: serializeAccessRole(created), syncState: "synced" });
      } catch (err) {
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        next(err);
      }
    },
  );

  // ── PATCH /api/access/roles/:id ─────────────────────────────
  router.patch(
    "/access/roles/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = rolePatchSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const body = parsed.data;

        const existing = await loadRole(req.params.id);
        if (!existing) return res.status(404).json({ error: "Role not found" });

        const nextStartingPoint = (body.startingPoint ??
          existing.startingPoint) as AssignableRole;
        const startingPointChanged = nextStartingPoint !== existing.startingPoint;

        // Rail 3 + 7 on the NEW tier. Pure actor-vs-requested (no DB read),
        // so it stays OUT of the transaction to fail fast.
        if (startingPointChanged) {
          assertAssignableForCreate({
            actorRole: req.user?.role,
            requestedRole: nextStartingPoint,
            rankMessage: "You cannot move a role above your own rank",
          });
        }

        // The member list is read INSIDE the transaction below (review B2):
        // a pre-transaction snapshot silently skips anyone assigned to the
        // role between the read and the write, leaving User.role at the OLD
        // (higher) tier while startingPoint moved down — layer-1 requireRole
        // then honours that stale tier indefinitely, and nothing reconciles
        // it. Declared here only so the post-commit rail-6 loop can see what
        // the transaction actually re-tiered.
        let members: Array<{
          id: string;
          role: string;
          username: string;
          nextcloudUsername: string | null;
          // WARP-1526 (pr-reviewer #1229 N2): rail 5 counts NON-disabled
          // operators, so the in-tx invariants need each member's current
          // enable state — a DEACTIVATED member holds no live access and
          // must not block a starting-point demotion.
          directoryStatus: string;
        }> = [];

        // Grant axes: a provided array replaces wholesale (normalized for
        // the EFFECTIVE starting point); an absent axis re-clamps its
        // STORED rows when the starting point dropped (server-side §12
        // re-floor — never silently over-floor).
        const grants = normalizeGrants({
          startingPoint: nextStartingPoint,
          featureGrants: (body.featureGrants ??
            existing.featureGrants.map((g) => ({
              moduleId: g.moduleId as GateableModuleId,
              level: g.level as FeatureLevel,
            }))) as Array<{ moduleId: GateableModuleId; level: FeatureLevel }>,
          toolGrants:
            body.toolGrants ??
            existing.toolGrants.map((g) => ({
              domain: g.domain,
              level: g.level as "view" | "use",
            })),
          connectorGrants:
            body.connectorGrants ??
            existing.connectorGrants.map((g) => ({
              provider: g.provider,
              level: g.level as ConnectorLevel,
            })),
          mayOperateLocks: body.mayOperateLocks ?? existing.mayOperateLocks,
        });

        const nextStorage =
          body.storageQuotaBytes === undefined
            ? undefined
            : body.storageQuotaBytes === null
              ? null
              : BigInt(body.storageQuotaBytes);
        const storageChanged =
          nextStorage !== undefined && nextStorage !== existing.storageQuotaBytes;
        const storageCleared =
          storageChanged && nextStorage === null && existing.storageQuotaBytes !== null;

        await prisma.$transaction(async (tx) => {
          await tx.accessRole.update({
            where: { id: existing.id },
            data: {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.startingPoint !== undefined
                ? { startingPoint: nextStartingPoint }
                : {}),
              ...(body.state !== undefined ? { state: body.state } : {}),
              ...(nextStorage !== undefined ? { storageQuotaBytes: nextStorage } : {}),
              ...(body.maxUploadSizeMb !== undefined
                ? { maxUploadSizeMb: body.maxUploadSizeMb }
                : {}),
              ...(body.llmDailyMessageCap !== undefined
                ? { llmDailyMessageCap: body.llmDailyMessageCap }
                : {}),
              ...(body.cloudModelsAllowed !== undefined
                ? { cloudModelsAllowed: body.cloudModelsAllowed }
                : {}),
              mayOperateLocks: grants.mayOperateLocks,
            },
          });

          // Replace grant rows whenever the normalized set can differ from
          // what's stored (axis provided, or a starting-point re-floor).
          if (body.featureGrants !== undefined || startingPointChanged) {
            await tx.accessRoleFeatureGrant.deleteMany({ where: { roleId: existing.id } });
            if (grants.featureGrants.length > 0) {
              await tx.accessRoleFeatureGrant.createMany({
                data: grants.featureGrants.map((g) => ({ roleId: existing.id, ...g })),
              });
            }
          }
          if (body.toolGrants !== undefined) {
            await tx.accessRoleToolGrant.deleteMany({ where: { roleId: existing.id } });
            if (grants.toolGrants.length > 0) {
              await tx.accessRoleToolGrant.createMany({
                data: grants.toolGrants.map((g) => ({ roleId: existing.id, ...g })),
              });
            }
          }
          if (body.connectorGrants !== undefined || startingPointChanged) {
            await tx.accessRoleConnectorGrant.deleteMany({ where: { roleId: existing.id } });
            if (grants.connectorGrants.length > 0) {
              await tx.accessRoleConnectorGrant.createMany({
                data: grants.connectorGrants.map((g) => ({ roleId: existing.id, ...g })),
              });
            }
          }

          if (startingPointChanged) {
            // B2: read the membership INSIDE the transaction, so anyone
            // assigned to this role concurrently is either included here or
            // serialized behind us — never silently left on the old tier.
            members = (await tx.user.findMany({
              where: { accessRoleId: existing.id },
              select: {
                id: true,
                role: true,
                username: true,
                nextcloudUsername: true,
                directoryStatus: true,
              },
            })) as typeof members;

            for (const member of members) {
              // Rails 2 + 1 + 3 + 7 per member (self, owner-untouchable on
              // drifted data, rank, assignable). Moved in with the read —
              // RoleMutationRefusedError propagates out of the transaction,
              // rolling it back, and the route catch maps it to its 4xx
              // (the people.ts DELETE precedent).
              assertRoleChangeAllowed({
                actor: { id: req.user?.id, role: req.user?.role },
                target: { id: member.id, role: member.role as never },
                requestedRole: nextStartingPoint,
              });
              // Rails 4 + 5 per member — a demotion that would strand the
              // box without operators rolls the whole role change back.
              await assertRoleChangeInvariantsTx(tx, {
                target: {
                  id: member.id,
                  role: member.role as never,
                  directoryStatus: member.directoryStatus as never,
                },
                requestedRole: nextStartingPoint,
              });
              await tx.user.update({
                where: { id: member.id },
                data: { role: nextStartingPoint },
              });
            }
          }
        }, SERIALIZABLE_TX);

        // Rail 6 per member. A member whose tier ACTUALLY crossed runs the
        // consolidated runner (revoke → NC droplet-admins cascade → the
        // "Role changed" audit row); a member already sitting at the target
        // tier only gets their sessions revoked — emitting
        // "Role changed: family → family" would be a lie in the audit log.
        // Matches how the assign route distinguishes the two cases.
        for (const member of members) {
          if (member.role !== nextStartingPoint) {
            await runRoleChangePostEffects({
              target: {
                id: member.id,
                username: member.username,
                nextcloudUsername: member.nextcloudUsername,
              },
              previousRole: member.role as never,
              nextRole: nextStartingPoint,
              actorUsername: req.user?.username ?? null,
              actor: actorFromRequest(req),
            });
          } else {
            await revokeAllSessions(member.id);
          }
        }

        const updated = (await loadRole(existing.id)) as RoleWithMeta;
        const memberCount = updated._count.users;

        // Carried obligation 3 — the reconcile decision (see module doc).
        let retainedQuotaCount: number | undefined;
        let usageConverging = false;
        if (storageChanged && memberCount > 0) {
          if (storageCleared) {
            const memberPolicies = await prisma.user.findMany({
              where: { accessRoleId: existing.id },
              select: {
                id: true,
                usagePolicy: { select: { storageQuotaBytes: true } },
              },
            });
            retainedQuotaCount = memberPolicies.filter(
              (m) => m.usagePolicy?.storageQuotaBytes == null,
            ).length;
          } else {
            kickReconcile();
            usageConverging = true;
          }
        }

        const archivedNow = body.state === "archived" && existing.state !== "archived";
        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "shield",
          what: archivedNow ? "Access role archived" : "Access role updated",
          sub: updated.name,
          refs: {
            actor: req.user?.username ?? null,
            roleId: updated.id,
            roleName: updated.name,
            startingPointChanged,
            reTieredUserIds: members.map((m) => m.id),
            fields: Object.keys(body),
          },
          actor: actorFromRequest(req),
        });

        res.json({
          role: serializeAccessRole(updated),
          syncState: startingPointChanged || usageConverging ? "pending" : "synced",
          ...(retainedQuotaCount !== undefined ? { retainedQuotaCount } : {}),
        });
      } catch (err) {
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        next(err);
      }
    },
  );

  // ── DELETE /api/access/roles/:id ────────────────────────────
  router.delete(
    "/access/roles/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const existing = await loadRole(req.params.id);
        if (!existing) return res.status(404).json({ error: "Role not found" });

        const [members, pendingInvites] = await Promise.all([
          prisma.user.findMany({
            where: { accessRoleId: existing.id },
            select: { id: true, username: true, displayName: true },
          }),
          // Pending = not accepted, not revoked, not past expiry. The
          // accept path would assign the role (T9), so these are future
          // members and block exactly like current ones.
          prisma.userInvite.findMany({
            where: {
              accessRoleId: existing.id,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { id: true, username: true, email: true },
          }),
        ]);

        if (members.length > 0 || pendingInvites.length > 0) {
          return res.status(409).json({
            ...ROLE_IN_USE,
            members: members.map((m) => ({
              id: m.id,
              username: m.username,
              displayName: m.displayName,
            })),
            pendingInvites: pendingInvites.map((i) => ({
              id: i.id,
              username: i.username,
              email: i.email,
            })),
          });
        }

        await prisma.$transaction(async (tx) => {
          // Non-pending invite rows are RETAINED state (accepted/revoked/
          // expired — never deleted) and reference the role via an
          // onDelete: Restrict FK. Release exactly those so the delete can
          // clear; historic rows simply lose the pointer. The filter is
          // deliberately the COMPLEMENT of the pending pre-check above: a
          // pending invite that raced in after the pre-check keeps its
          // pointer, the Restrict FK refuses the delete, and the whole
          // transaction (release included) rolls back → the same 409.
          await tx.userInvite.updateMany({
            where: {
              accessRoleId: existing.id,
              OR: [
                { acceptedAt: { not: null } },
                { revokedAt: { not: null } },
                { expiresAt: { lte: new Date() } },
              ],
            },
            data: { accessRoleId: null },
          });
          await tx.accessRole.delete({ where: { id: existing.id } });
        }, SERIALIZABLE_TX);

        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "shield-off",
          what: "Access role deleted",
          sub: existing.name,
          refs: {
            actor: req.user?.username ?? null,
            roleId: existing.id,
            roleName: existing.name,
          },
          actor: actorFromRequest(req),
        });

        // Delete requires zero members, so nothing NC-affecting converges.
        res.json({ syncState: "synced" });
      } catch (err) {
        if (isForeignKeyError(err)) {
          // check→delete race: someone was assigned (or invited) between
          // the pre-check and the transaction — the Restrict FK is the
          // backstop; answer exactly like the pre-check.
          logger.warn(
            { roleId: req.params.id },
            "role delete blocked by FK restrict (assignment race)",
          );
          return res.status(409).json(ROLE_IN_USE);
        }
        next(err);
      }
    },
  );

  // ── POST /api/access/roles/:id/assign ───────────────────────
  router.post(
    "/access/roles/:id/assign",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = assignSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        // B2: the role row (state + startingPoint) AND the target rows are
        // read INSIDE the transaction. Read outside, a concurrent archive or
        // re-base would let us write `role: <stale startingPoint>` — the
        // person lands on a tier the role no longer carries, with layer-1
        // requireRole honouring it indefinitely.
        type AssignTarget = {
          id: string;
          role: string;
          username: string;
          nextcloudUsername: string | null;
          accessRoleId: string | null;
          // WARP-1526 (pr-reviewer #1229 N2): carried for the in-tx rails —
          // rail 5's "last operator" count excludes disabled people, so the
          // target's own enable state is part of the invariant's input.
          directoryStatus: string;
        };
        let startingPoint: AssignableRole = "guest";
        let roleName = "";
        let changed: AssignTarget[] = [];

        await prisma.$transaction(async (tx) => {
          const role = await tx.accessRole.findUnique({ where: { id: req.params.id } });
          if (!role) {
            throw new AccessPreconditionError(404, { error: "Role not found" });
          }
          if (role.state === "archived") {
            throw new AccessPreconditionError(409, {
              error: "This role is archived — restore it before assigning people.",
              code: "ACCESS_ROLE_ARCHIVED",
            });
          }
          startingPoint = role.startingPoint as AssignableRole;
          roleName = role.name;

          const targets = (await tx.user.findMany({
            where: { id: { in: parsed.data.userIds } },
            select: {
              id: true,
              role: true,
              username: true,
              nextcloudUsername: true,
              accessRoleId: true,
              directoryStatus: true,
            },
          })) as AssignTarget[];
          const foundIds = new Set(targets.map((t) => t.id));
          const missing = parsed.data.userIds.filter((id) => !foundIds.has(id));
          if (missing.length > 0) {
            throw new AccessPreconditionError(404, { error: "User not found", missing });
          }

          changed = targets.filter(
            (t) => t.accessRoleId !== role.id || t.role !== startingPoint,
          );

          // Rails per target — self, owner-untouchable, rank cap, assignable
          // enum (via the role's startingPoint). ALL targets must pass before
          // ANY row changes (all-or-nothing, §2 "the assignment
          // transaction"); a refusal throws out and rolls back.
          for (const target of changed) {
            assertRoleChangeAllowed({
              actor: { id: req.user?.id, role: req.user?.role },
              target: { id: target.id, role: target.role as never },
              requestedRole: startingPoint,
            });
          }

          for (const target of changed) {
            await assertRoleChangeInvariantsTx(tx, {
              target: {
                id: target.id,
                role: target.role as never,
                directoryStatus: target.directoryStatus as never,
              },
              requestedRole: startingPoint,
            });
            await tx.user.update({
              where: { id: target.id },
              data: { accessRoleId: role.id, role: startingPoint },
            });
          }
        }, SERIALIZABLE_TX);

        if (changed.length === 0) {
          // Everyone already holds this role at its tier — a quiet no-op
          // (the people.ts no-op-PATCH precedent): no revoke, no audit noise.
          return res.json({ syncState: "synced" });
        }

        // Rail 6 per member. A tier crossing runs the full consolidated
        // runner (revoke → NC droplet-admins cascade → "Role changed");
        // a same-tier role swap still revokes (the person's effective
        // access changed) without a misleading tier-change audit row.
        for (const target of changed) {
          if (target.role !== startingPoint) {
            await runRoleChangePostEffects({
              target: {
                id: target.id,
                username: target.username,
                nextcloudUsername: target.nextcloudUsername,
              },
              previousRole: target.role as never,
              nextRole: startingPoint,
              actorUsername: req.user?.username ?? null,
              actor: actorFromRequest(req),
            });
          } else {
            await revokeAllSessions(target.id);
          }
        }

        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "shield",
          what: "Access role assigned",
          sub: `${roleName} → ${changed.length} ${changed.length === 1 ? "person" : "people"}`,
          refs: {
            actor: req.user?.username ?? null,
            roleId: req.params.id,
            roleName,
            userIds: changed.map((t) => t.id),
          },
          actor: actorFromRequest(req),
        });

        // The change cascades (sessions revoked; NC group/quota convergence
        // follows) — the UI's "Saved. Applying…" line keys off pending.
        res.json({ syncState: "pending" });
      } catch (err) {
        if (err instanceof AccessPreconditionError) {
          return res.status(err.status).json(err.body);
        }
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        next(err);
      }
    },
  );

  return router;
}
