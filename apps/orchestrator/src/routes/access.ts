/**
 * WARP-1527 / ADR-032 §5 (RBAC v2 T3) — the Access & Roles admin surface.
 *
 * Surface owned by this file (all owner+admin, people.ts conventions:
 * UUIDs everywhere, BigInt as strings, RoleMutationRefusedError mapped to
 * its status, every mutation Activity-audited kind="auth"):
 *
 *   GET    /api/access/roles             — { roles: AccessRole[] }
 *   GET    /api/access/role-templates    — { roleTemplates, enforcedModuleIds }
 *   POST   /api/access/roles             — create; { sourceRoleId } duplicates,
 *                                          { templateId } instantiates a template
 *   GET    /api/access/roles/:id         — { role }
 *   PATCH  /api/access/roles/:id         — update / archive + restore ({ state })
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
 * until edited — for the UI's honest confirm line (consumed by the role
 * editor as of WARP-1576).
 *
 * Role templates (WARP-2738). ADR-032 shipped the engine and nothing to start
 * from. `services/access-role-templates.ts` holds eight code-resident starting
 * points; `GET /access/role-templates` serves the catalogue and
 * `POST /access/roles { templateId }` instantiates one. A template is NOT a
 * seeded row and gets NO private write path: the branch expands the template
 * to the ordinary create payload and then runs the same rails a hand-authored
 * body runs — `assertAssignableForCreate`, `normalizeGrants`, `createRoleTx`
 * inside the same SERIALIZABLE transaction — so what lands is an ordinary,
 * fully editable AccessRole row. The GET also ships `enforcedModuleIds`
 * (derived from `FEATURE_GATED_MODULES`) because a feature grant NARROWS what
 * a person reaches only on the modules whose layer-2 gate is mounted; on the
 * rest it drives the nav and the API still answers, and the panel has to be
 * able to say which is which.
 *
 * Archive/restore (WARP-1560, WARP-1569). `state` moves both ways through
 * this same PATCH, and each TRANSITION — not the requested value — gets its
 * own Activity string ("Access role archived" / "Access role restored"); a
 * PATCH restating the state a role already holds is an ordinary update.
 * Archiving stops the role MANAGING anything (unassignable, and the usage
 * reconciler stands its defaults down) while never stripping access from
 * the people who hold it (`effective-access.service.ts` deliberately does
 * not read `state`). Restoring therefore has a usage tail that archiving
 * does not: the members it stopped managing converge back onto its storage
 * default, so a restore kicks the reconciler and answers `pending`.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { ModuleId, PrismaClient, Prisma } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  AccessPreconditionError,
  isAccessPreconditionError,
} from "../lib/access-precondition.js";
import {
  RoleMutationRefusedError,
  SERIALIZABLE_TX,
  ASSIGNABLE_ROLES,
  type AssignableRole,
  assertAssignableForCreate,
  assertRoleChangeAllowed,
  assertRoleChangeInvariantsTx,
  isConcurrencyConflict,
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
import {
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_BY_ID,
  isRoleTemplateId,
  roleTemplateCreatePayload,
  type RoleTemplate,
} from "../services/access-role-templates.js";
// The layer-2 (per-person) gate roster, straight from the composition that
// mounts it. Imported, never restated: this set has moved twice already
// (WARP-1585 added knowledge/docs; crm/money followed), and a dashboard-side
// copy would go stale silently — labelling a grant "enforced" that isn't.
// No cycle: module-mounts reaches the registry, the two gate middlewares and
// effective-access, none of which import a route module.
import { FEATURE_GATED_MODULES } from "../modules/module-mounts.js";
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

/**
 * WARP-2738 — template instantiation: POST /access/roles { templateId }.
 *
 * `templateId` is a plain bounded string, deliberately NOT a `z.enum` over the
 * catalogue ids: a well-formed id that names no template is a MISSING
 * RESOURCE (404 — the same answer an unknown `sourceRoleId` already gets), and
 * an enum would turn it into a 400 "Invalid request" that tells the operator
 * their request was malformed when it wasn't. Membership is checked in the
 * handler with `isRoleTemplateId`, which is itself derived from
 * ROLE_TEMPLATES — the id vocabulary is never restated here.
 *
 * `sourceRoleId` is declared only in order to REFUSE it. The duplicate branch
 * silently ignores every other body field, so a body carrying both ids would
 * otherwise have one of them quietly win; the two shapes are mutually
 * exclusive instead.
 */
const templateCreateSchema = z.object({
  templateId: z.string().min(1).max(128),
  /** Optional rename at instantiation. Same constraints as
   *  `rolePayloadSchema.name` (reused, not restated) — and the slug stays
   *  server-derived from whichever name wins, never client-supplied. */
  name: rolePayloadSchema.shape.name.optional(),
  sourceRoleId: z.unknown().refine((v) => v === undefined, {
    message:
      "Send templateId or sourceRoleId, never both — a create is an instantiation or a duplicate.",
  }),
});

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

/**
 * WARP-2738 — the role-template wire shape.
 *
 * An explicit projection rather than `res.json(ROLE_TEMPLATES)`: the catalogue
 * is an internal code object and a field added there must be a DELIBERATE API
 * change here, not one that ships by accident. The grant arrays are copied out
 * of the frozen literals for the same reason `roleTemplateCreatePayload` does
 * it — nothing hands a caller a live reference into a process-wide constant.
 *
 * A template has no id-in-the-database, no people and no state, so this shape
 * is deliberately NOT the AccessRole shape: it is what the builder needs to
 * render a card and post `{ templateId }` back.
 */
function serializeRoleTemplate(t: RoleTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    startingPoint: t.startingPoint,
    featureGrants: t.featureGrants.map((g) => ({ moduleId: g.moduleId, level: g.level })),
    toolGrants: t.toolGrants.map((g) => ({ domain: g.domain, level: g.level })),
    connectorGrants: t.connectorGrants.map((g) => ({ provider: g.provider, level: g.level })),
    cloudModelsAllowed: t.cloudModelsAllowed,
    mayOperateLocks: t.mayOperateLocks,
    storageQuotaBytes: t.storageQuotaBytes,
    maxUploadSizeMb: t.maxUploadSizeMb,
    llmDailyMessageCap: t.llmDailyMessageCap,
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

/**
 * The refusal→response mapping every mutating route in this file shares.
 * Returns true when it answered, so the caller falls through to `next(err)`
 * only for genuinely unexpected failures.
 *
 * The second branch is WARP-2738's fix to a shipped gap. Every mutation here
 * opens at SERIALIZABLE, which means the LOSER of a conflict aborts with
 * P2034 by design — that is the whole point of the isolation level, not an
 * error. This file never imported `isConcurrencyConflict`, so that abort fell
 * through to the generic error handler and the operator got a 500 for a
 * request that simply needs retrying; access.routes.test.ts pinned exactly
 * that as a known gap. Role templates make the race routine rather than
 * exotic — two operators clicking "Front Desk" at once both derive the same
 * slug base — so the mapping lands with them.
 *
 * P2025 rides along for the same reason people.ts maps it: our writes are
 * keyed on rows re-read inside the transaction, and "the row moved under us"
 * is the same story to the caller as "we lost the serialization race" —
 * nothing was applied, retry. Neither is attributed to a specific rail: we
 * cannot know which invariant the concurrent writer would have tripped, and
 * naming one would be a lie in the audit trail.
 */
function mapMutationRefusal(res: Response, err: unknown): boolean {
  if (err instanceof RoleMutationRefusedError) {
    res.status(err.status).json(err.toJSON());
    return true;
  }
  if (isConcurrencyConflict(err)) {
    const conflict = RoleMutationRefusedError.concurrentMutation();
    res.status(conflict.status).json(conflict.toJSON());
    return true;
  }
  return false;
}

function isForeignKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2003";
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

  // ── GET /api/access/role-templates ──────────────────────────
  //
  // WARP-2738 — the catalogue the builder starts from. Code-resident, static,
  // and identical on every box, so it caches exactly like /api/business-types
  // (private, max-age=300) and holds no per-box state; owner+admin like every
  // other surface in this file, because it is part of the Access panel rather
  // than something a narrowed person has any use for.
  //
  // `enforcedModuleIds` is the half that makes the catalogue honest, and the
  // reason this endpoint exists at all rather than the dashboard bundling the
  // templates. A feature grant only NARROWS what a person can reach on the
  // modules whose layer-2 gate is actually mounted (FEATURE_GATED_MODULES,
  // modules/module-mounts.ts); on every other module the grant drives the nav
  // and nothing else — the menu entry hides and the API still answers. The
  // panel must be able to say which is which, and denial on the enforced ones
  // is a 404 `module_disabled` that is byte-identical to the box-wide toggle,
  // so the honest copy is "they will not see it", never "they will be told
  // they lack permission".
  //
  // Path note: the second segment is `role-templates`, not `roles`, so the
  // `/access/roles/:id` route below cannot shadow it whatever the order.
  router.get(
    "/access/role-templates",
    requireRole("owner", "admin"),
    (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({
        roleTemplates: ROLE_TEMPLATES.map(serializeRoleTemplate),
        enforcedModuleIds: [...FEATURE_GATED_MODULES],
      });
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

  // ── POST /api/access/roles (create | duplicate | instantiate) ──
  router.post(
    "/access/roles",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actorId = req.user?.id ?? "unknown";

        // Three request shapes on one verb, discriminated by the body:
        //   { templateId }    instantiate a catalogue template (WARP-2738)
        //   { sourceRoleId }  duplicate an existing role — the server copies
        //                     the grant set and derives a fresh name/slug (§5)
        //   full payload      hand-authored create
        //
        // templateId is tested FIRST, and the two id fields are mutually
        // exclusive (refused below, not silently resolved): the duplicate
        // branch ignores every other field in the body, so a body carrying
        // both would have one id quietly win and the other vanish.
        const idFields = (req.body ?? {}) as {
          templateId?: unknown;
          sourceRoleId?: unknown;
        };
        const isTemplate = typeof idFields.templateId === "string";
        const isDuplicate = !isTemplate && typeof idFields.sourceRoleId === "string";

        let name: string;
        let description: string | null;
        let startingPoint: AssignableRole;
        let storageQuotaBytes: bigint | null;
        let maxUploadSizeMb: number | null;
        let llmDailyMessageCap: number | null;
        let cloudModelsAllowed: boolean;
        let grants: NormalizedGrants;
        let duplicatedFrom: string | null = null;
        /** The template this role was instantiated from — the Activity `refs`
         *  slot that mirrors `duplicatedFrom`, and null on the other two
         *  branches. Provenance only: the row is ordinary and editable the
         *  moment it lands, and nothing reads this back. */
        let instantiatedFrom: string | null = null;

        if (isTemplate) {
          const parsed = templateCreateSchema.safeParse(req.body);
          if (!parsed.success) {
            return res
              .status(400)
              .json({ error: "Invalid request", details: parsed.error.flatten() });
          }
          const template = isRoleTemplateId(parsed.data.templateId)
            ? ROLE_TEMPLATE_BY_ID.get(parsed.data.templateId)
            : undefined;
          if (!template) return res.status(404).json({ error: "Role template not found" });

          // Expanded through the catalogue's own projection — the route never
          // reads the template's internal shape, so a payload-contract change
          // breaks at compile time in one place.
          const templatePayload = roleTemplateCreatePayload(template);

          // Rails 3 + 7, exactly as the hand-authored branch runs them, and
          // deliberately NOT the duplicate branch's behaviour below (which
          // skips this — a known wart, not a pattern to copy). Three of the
          // eight templates are admin-based; without this rail a template
          // would be a way around the rank cap. An admin instantiating an
          // admin-based template passes — equal rank is allowed.
          assertAssignableForCreate({
            actorRole: req.user?.role,
            requestedRole: templatePayload.startingPoint,
            rankMessage: "You cannot create a role above your own rank",
          });

          instantiatedFrom = template.id;
          // The optional rename; the SLUG is derived server-side from
          // whichever name wins (deriveUniqueSlug, inside the transaction).
          name = parsed.data.name ?? templatePayload.name;
          description = templatePayload.description;
          startingPoint = templatePayload.startingPoint;
          storageQuotaBytes =
            templatePayload.storageQuotaBytes === null
              ? null
              : BigInt(templatePayload.storageQuotaBytes);
          maxUploadSizeMb = templatePayload.maxUploadSizeMb;
          llmDailyMessageCap = templatePayload.llmDailyMessageCap;
          cloudModelsAllowed = templatePayload.cloudModelsAllowed;
          // Through the SAME server re-clamp as any hand-authored body. The
          // templates are authored so this is a no-op — access-role-
          // templates.test.ts is what proves that, by re-running these exact
          // clamps — but the clamp stays the boundary rather than a claim the
          // catalogue makes about itself.
          grants = normalizeGrants({
            startingPoint,
            featureGrants: templatePayload.featureGrants,
            toolGrants: templatePayload.toolGrants,
            connectorGrants: templatePayload.connectorGrants,
            mayOperateLocks: templatePayload.mayOperateLocks,
          });
        } else if (isDuplicate) {
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
            templateId: instantiatedFrom,
          },
          actor: actorFromRequest(req),
        });

        // No members yet — nothing NC-affecting to converge.
        res.json({ role: serializeAccessRole(created), syncState: "synced" });
      } catch (err) {
        if (mapMutationRefusal(res, err)) return;
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

        // WARP-1560 — the two state TRANSITIONS, not the requested value: a
        // PATCH restating the state a role is already in is an ordinary
        // update and must not claim otherwise in Activity.
        const archivedNow = body.state === "archived" && existing.state !== "archived";
        const restoredNow = body.state === "active" && existing.state !== "active";

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

        // WARP-1560 / WARP-1569 — a RESTORE is a usage-convergence event in
        // its own right: the reconciler stopped pushing this role's storage
        // default the moment it was archived, so bringing the role back means
        // every member without a person-level quota converges onto it again.
        // Kick the same debounced pass a set/changed default kicks, and
        // report `pending` — `synced` would be a lie for up to a full tick.
        // Read the POST-patch default (a restore that clears the default in
        // the same request converges nothing), and never double-kick when the
        // storage branch above already did. ARCHIVING is deliberately not the
        // mirror image: it stops managing rather than pushing anything, so
        // there is nothing to wait for and nothing to report.
        const storageAfter = nextStorage !== undefined ? nextStorage : existing.storageQuotaBytes;
        if (restoredNow && storageAfter !== null && memberCount > 0 && !usageConverging) {
          kickReconcile();
          usageConverging = true;
        }

        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "shield",
          what: archivedNow
            ? "Access role archived"
            : restoredNow
              ? "Access role restored"
              : "Access role updated",
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
        if (mapMutationRefusal(res, err)) return;
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
        if (mapMutationRefusal(res, err)) return;
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
          if (!role) throw AccessPreconditionError.roleNotFound();
          if (role.state === "archived") throw AccessPreconditionError.roleArchived();
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
            throw AccessPreconditionError.userNotFound(missing);
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
        // One shape for all three: a precondition, a rail refusal and a lost
        // serialization race are the same story to the caller — the
        // transaction unwound, nothing was applied (WARP-1583, WARP-2738).
        if (isAccessPreconditionError(err)) {
          return res.status(err.status).json(err.toJSON());
        }
        if (mapMutationRefusal(res, err)) return;
        next(err);
      }
    },
  );

  return router;
}
