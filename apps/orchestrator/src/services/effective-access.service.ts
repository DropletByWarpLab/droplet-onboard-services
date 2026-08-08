/**
 * WARP-1527 / ADR-032 §3 (RBAC v2 T3) — the effective-access resolver.
 *
 * The ONE layer-2 resolver every per-person authorization surface consults
 * (module gate T4, tool-catalog builder T5, cloud router + connector routes
 * T6, and the People UI's read-only drawer via GET
 * /api/people/:id/effective-access). The COMPOSITION below follows §3:
 *
 *   tier          = User.role                       (the ADR-004 floor)
 *   features      = tier==owner ? ALL
 *                   : clamp(roleFeatureGrants ⊕ exceptions,
 *                           catalogFloor(tier)) ∩ workspaceModules
 *   toolDomains   = writeFilter(tier) ∩ moduleToolDomains(features)
 *                   ∩ roleToolGrants
 *   locks         = role.mayOperateLocks && smart_home ∈ features
 *   cloud         = workspace.cloud_model_escape && role.cloudModelsAllowed
 *   connectors[p] = min(roleConnectorGrant(p),
 *                       connection.writeEnabled ? read_write : read)
 *   connectorGrants[p] = roleConnectorGrant(p)      (raw — WARP-1579)
 *   usage         = UserUsagePolicy ?? roleDefaults ?? box default   (T7)
 *   deptRights    = read-only reference (ADR-029 owns them)
 *
 * ONLY `owner` bypasses this layer — admins can be narrowed (that is the
 * point of Admin-based custom roles). Do NOT copy requireScope's
 * owner/admin short-circuit here. `service` principals keep their dedicated
 * requireRoleOrService paths and never resolve through this module. A null
 * `accessRoleId` (every user today) resolves to the tier's FULL catalog —
 * today's behavior bit-for-bit; the coarse requireRole floors stay
 * enforcing unchanged at layer 1.
 *
 * ARCHIVE ≠ REVOKE (deliberate, review C2). `AccessRole.state` is NOT read
 * here: archiving a role stops it being ASSIGNABLE (both assign paths 409
 * on an archived role) but never silently strips access from the people who
 * already hold it — that would be a mass, invisible permission change fired
 * by a UI action whose copy says "archive". The operator's explicit path to
 * remove access is reassignment (or delete, which is blocked until the role
 * is empty). `GET /api/access/roles` therefore returns archived and active
 * roles alike, each carrying its `state` for the client to group by.
 * Pinned by "an ARCHIVED role still resolves its grants for existing
 * members (archive is not revoke)".
 *
 * READ CONSISTENCY (review C1, closed by WARP-1583). The composition
 * follows §3, and every read it composes now comes from ONE snapshot: the
 * fetch wrapper opens a single `RepeatableRead` transaction and threads that
 * handle through the whole read set, `getEffectiveModuleIds` included.
 *
 * Before that, each statement took its own READ COMMITTED snapshot — the
 * user row, each of its nested relation selects (Prisma's default
 * relation-load strategy is `query`, so a nested `select` is separate
 * statements, not a join), and every member of the parallel batch. A role
 * change committing mid-resolve therefore yielded a mixed view.
 *
 * On the FEATURE axis that was bounded and one-directional: `clampLevel`
 * re-clamps every grant against the tier at compose time, so a torn read
 * could only UNDER-permit. That is why it shipped.
 *
 * The guarantee never extended to the CONNECTORS axis, which applies no
 * compose-time tier floor — only `min(roleGrant, connection.writeEnabled)`.
 * The O-2 floor (read_write is selectable only on Admin-based roles) lives
 * in `normalizeGrants` at WRITE time, so a resolve straddling a
 * `PATCH /api/access/roles/:id {startingPoint}` returned a tier paired with
 * grants normalized for a DIFFERENT tier — `family` holding `read_write`,
 * WIDER than any committed state, with nothing to clamp it. T6 (WARP-1530)
 * owns the connector enforcement path and consumes this result directly.
 *
 * REPEATABLE READ and not SERIALIZABLE, deliberately: this transaction
 * writes nothing, so it has no write-write conflict to lose, but Postgres
 * SSI can still abort a read-only transaction to preserve serializability —
 * which would turn a plain authorization read into a P2034 and a 500 on
 * every route the feature gate protects. See `lib/prisma-tx.ts`.
 *
 * Shape: scope-loader-shaped singleton (module-bound Prisma + availability
 * config, idempotent boot init beside initScopeLoader, fail-closed throw
 * when unwired, `_setForTests` hook). DB-read per request; box scale is
 * tens of users — deliberately NO cache in v1.
 *
 * The pure composition (computeEffectiveAccess) is exported separately so
 * the resolver matrix tests need no DB, and so T4/T5/T6 callers that
 * already hold the rows can compose without a second read.
 */
import type { DepartmentKind, ModuleId, PrismaClient } from "@prisma/client";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import type { Role } from "./jwt.service.js";
import {
  resolveEffectiveUsage,
  type EffectiveUsageSource,
} from "./effective-usage.service.js";
import {
  ALWAYS_ON_FEATURES,
  GATEABLE_MODULE_IDS,
  clampLevel,
  domainsForFeatures,
  fullCatalogFeatures,
  isGateableModuleId,
  tierReachableDomains,
  type ConnectorLevel,
  type FeatureLevel,
} from "./access-catalog.js";
import {
  satisfiedModuleIds,
  type AvailabilityConfig,
} from "../modules/module-registry.js";
import { getEffectiveModuleIds } from "./modules.service.js";
import { REPEATABLE_READ_TX } from "../lib/prisma-tx.js";

// ── shapes ─────────────────────────────────────────────────────────

export interface AccessRoleGrantRows {
  mayOperateLocks: boolean;
  cloudModelsAllowed: boolean;
  storageQuotaBytes: bigint | null;
  maxUploadSizeMb: number | null;
  llmDailyMessageCap: number | null;
  featureGrants: Array<{ moduleId: ModuleId; level: FeatureLevel }>;
  toolGrants: Array<{ domain: string; level: "view" | "use" }>;
  connectorGrants: Array<{ provider: string; level: ConnectorLevel }>;
}

export interface AccessExceptionRow {
  id: string;
  moduleId: ModuleId;
  effect: "allow" | "deny";
  level: FeatureLevel | null;
}

export interface EffectiveAccessInputs {
  user: { id: string; role: Role; accessRole: AccessRoleGrantRows | null };
  exceptions: AccessExceptionRow[];
  /** Workspace-EFFECTIVE module ids (available ∧ enabled — modules.service). */
  workspaceModuleIds: ReadonlySet<ModuleId>;
  /** OffLanAllowlistChannel `cloud_model_escape` enabled (absent row = false). */
  cloudEscapeEnabled: boolean;
  connections: Array<{ provider: string; writeEnabled: boolean }>;
  usagePolicy: {
    storageQuotaBytes: bigint | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
  } | null;
  /** WARP-1809: `kind` rides along (additive) so the People-page drawer can
   *  render the HOUSEHOLD unit kind-keyed ("Workspace"), never name-keyed. */
  deptRights: Array<{ id: string; name: string; kind: DepartmentKind; right: string }>;
}

/** The §5 wire shape (matches the dashboard's EffectiveAccess type —
 *  WARP-1532 api contract; unknown extras there are ignored by design). */
export interface EffectiveAccessResult {
  tier: Role;
  features: Array<{ moduleId: ModuleId; level: FeatureLevel }>;
  toolDomains: string[];
  locks: boolean;
  cloud: boolean;
  connectors: Record<string, ConnectorLevel>;
  /**
   * WARP-1579 — the RAW per-provider ROLE grant, reported beside `connectors`
   * and NOT clamped by the connection.
   *
   * `connectors` folds `connection.writeEnabled` in via `min()`, which makes
   * "this role is deliberately read-only" and "this CONNECTION has writes
   * turned off" the same value. The ERP write gate has to tell those apart:
   * the first is a 403 about the role, the second is today's 409
   * `WRITE_NOT_ENABLED` about the connection, and each names a different
   * remedy. Collapsing them would trade one wrong answer for another.
   *
   * `null` = **nothing narrows this axis** — a role-less person (every user
   * before RBAC v2) or an owner (§3's one bypass). Deliberately distinct from
   * `{}`, which is the sharply different "this role holds no connector grants
   * at all" and is a denial, not a pass-through.
   *
   * Additive on the §5 wire shape; the dashboard ignores unknown extras.
   */
  connectorGrants: Record<string, ConnectorLevel> | null;
  usage: {
    storageQuotaBytes: string | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
    /** Headline provenance = the storage field's source (the NC-managed,
     *  roster-rendered field — T7 "roster shows source"). */
    source: EffectiveUsageSource;
    /** Per-field provenance — the honest per-field view (additive extra). */
    sources: {
      storageQuotaBytes: EffectiveUsageSource;
      maxUploadSizeMb: EffectiveUsageSource;
      llmDailyMessageCap: EffectiveUsageSource;
    };
  };
  /** WARP-1809: additive `kind` per entry — the dashboard renders HOUSEHOLD
   *  entries as "Workspace" keyed off kind; older clients ignore the extra. */
  deptRights: Array<{ id: string; name: string; kind: DepartmentKind; right: string }>;
  exceptions: AccessExceptionRow[];
}

// ── pure §3 composition ────────────────────────────────────────────

/** Tiers whose write filter (routes/llm.ts) leaves smart-home control tools
 *  reachable — today's lock-operation reality for role-less users. */
const LOCK_CAPABLE_TIERS: ReadonlySet<Role> = new Set(["owner", "admin", "family"]);

function minConnectorLevel(a: ConnectorLevel, b: ConnectorLevel): ConnectorLevel {
  return a === "read_write" && b === "read_write" ? "read_write" : "read";
}

function connectionLevels(
  connections: Array<{ provider: string; writeEnabled: boolean }>,
): Map<string, ConnectorLevel> {
  const out = new Map<string, ConnectorLevel>();
  for (const conn of connections) {
    // One connection per provider by design (ADR-032 §1.13); if rows ever
    // drift to multiples, any write-enabled row makes the provider
    // read_write-capable — the role grant and the staged-outbox confirm
    // remain the narrowing layers above.
    const prev = out.get(conn.provider);
    const level: ConnectorLevel = conn.writeEnabled ? "read_write" : "read";
    out.set(conn.provider, prev === "read_write" ? prev : level);
  }
  return out;
}

export function computeEffectiveAccess(inputs: EffectiveAccessInputs): EffectiveAccessResult {
  const { user } = inputs;
  const tier = user.role;
  const connLevels = connectionLevels(inputs.connections);

  // T7 usage line — import, never duplicate. Owner included: rail 1 keeps
  // admins from WRITING an owner policy row, but an owner's own row (self
  // edits are allowed on the usage surface) still resolves honestly.
  const usage = resolveEffectiveUsage(inputs.usagePolicy, user.accessRole);
  const usageWire: EffectiveAccessResult["usage"] = {
    storageQuotaBytes: usage.storageQuotaBytes.value?.toString() ?? null,
    maxUploadSizeMb: usage.maxUploadSizeMb.value,
    llmDailyMessageCap: usage.llmDailyMessageCap.value,
    source: usage.storageQuotaBytes.source,
    sources: {
      storageQuotaBytes: usage.storageQuotaBytes.source,
      maxUploadSizeMb: usage.maxUploadSizeMb.source,
      llmDailyMessageCap: usage.llmDailyMessageCap.source,
    },
  };

  // ── owner bypass — full control, outside every intersection (§3) ──
  if (tier === "owner") {
    return {
      tier,
      features: [
        ...ALWAYS_ON_FEATURES.map((f) => ({ ...f })),
        ...GATEABLE_MODULE_IDS.map((moduleId) => ({
          moduleId: moduleId as ModuleId,
          level: "manage" as FeatureLevel,
        })),
      ],
      toolDomains: [...TOOL_DOMAINS],
      locks: true,
      // The workspace escape channel is not a role narrowing — ai-gateway's
      // fail-closed 451 applies to owners too, so the resolver stays honest.
      cloud: inputs.cloudEscapeEnabled,
      connectors: Object.fromEntries(connLevels),
      // §3: an owner is never narrowed, so no role grant applies to them.
      connectorGrants: null,
      usage: usageWire,
      deptRights: inputs.deptRights,
      exceptions: inputs.exceptions,
    };
  }

  // ── features = clamp(roleGrants ⊕ exceptions, floor) ∩ workspace ──
  const levelByModule = new Map<ModuleId, FeatureLevel>();
  if (user.accessRole === null) {
    // Legacy / role-less: the tier's full catalog (today's world).
    for (const f of fullCatalogFeatures(tier)) levelByModule.set(f.moduleId, f.level);
  } else {
    for (const f of ALWAYS_ON_FEATURES) levelByModule.set(f.moduleId, f.level);
    for (const grant of user.accessRole.featureGrants) {
      if (!isGateableModuleId(grant.moduleId)) continue; // chat rows never exist; defensive
      levelByModule.set(grant.moduleId, clampLevel(tier, grant.moduleId, grant.level));
    }
  }
  for (const exception of inputs.exceptions) {
    if (!isGateableModuleId(exception.moduleId)) continue; // always-on floor is exception-immune
    if (exception.effect === "deny") {
      levelByModule.delete(exception.moduleId);
    } else {
      levelByModule.set(
        exception.moduleId,
        clampLevel(tier, exception.moduleId, exception.level ?? "view"),
      );
    }
  }
  // WARP-1528 (T4 / QA): the intersection applies to the GATEABLE modules
  // only — the always-on floor is exempt, the same way `isGateableModuleId`
  // already makes it exception-immune above.
  //
  // Why this is a correction and not a widening: core modules are exempt from
  // workspace ENABLEMENT everywhere else in the system. app.ts's module gate
  // does `if (def.core) continue`, so `/api/llm` is never enablement-gated,
  // and the owner branch returns before this loop, so owners keep `chat`
  // unconditionally. But `chat`'s registry AVAILABILITY is
  // `isSet(AI_GATEWAY_URL)`, so on a box with that env unset it drops out of
  // the workspace-effective set — and only role-holders reach this loop. The
  // result was a narrowing applied to the always-on floor that neither the
  // workspace gate nor the owner path applies.
  //
  // It also makes "a person's feature set is never empty" TRUE rather than
  // nearly-true: the dashboard's fail-open guard treats an empty
  // `effectiveForUser` as unresolved and falls back to the full workspace
  // list, which on a grantless role would have shown exactly the "Droplet
  // full of locked doors" this feature exists to prevent.
  //
  // Enforcement delta: none. `chat` is not in app.ts's FEATURE_GATED_MODULES,
  // so `requireFeatureAccess` is never mounted on `/api/llm` — this opens no
  // route, it only stops the resolver from lying about the floor.
  for (const moduleId of [...levelByModule.keys()]) {
    if (!isGateableModuleId(moduleId)) continue;
    if (!inputs.workspaceModuleIds.has(moduleId)) levelByModule.delete(moduleId);
  }
  // WARP-1585 — the PER-PERSON half of the registry's declared dependencies.
  //
  // A genuinely separate narrowing from the workspace intersection above, and
  // that is why it needs its own application rather than riding along: the box
  // can have Files on while THIS PERSON holds no Files grant, and `docs`
  // resolving in that state would claim a capability they cannot use. Docs has
  // no surface of its own — its editor sessions are minted on
  // `/api/files/:filePath(*)/editor-session`, which `files` gates — so a
  // Documents grant without a Files grant reaches nothing.
  //
  // It runs AFTER exceptions for the same reason the workspace intersection
  // does: an exception widens within the model, it does not suspend it. An
  // `allow` on docs cannot resurrect it without files, and a `deny` on files
  // takes docs with it.
  //
  // The rule itself lives once, in the registry (`satisfiedModuleIds`); this
  // is one of its two call sites, not a second derivation. `knowledge`
  // declares no parent and is deliberately untouched here.
  const satisfied = satisfiedModuleIds(new Set(levelByModule.keys()));
  for (const moduleId of [...levelByModule.keys()]) {
    if (!satisfied.has(moduleId)) levelByModule.delete(moduleId);
  }
  const features = [...levelByModule.entries()].map(([moduleId, level]) => ({
    moduleId,
    level,
  }));
  const featureIds = new Set(levelByModule.keys());

  // ── toolDomains = writeFilter ∩ moduleToolDomains ∩ roleToolGrants ──
  const reachable = tierReachableDomains(tier);
  const featureDomains = domainsForFeatures(featureIds);
  const granted =
    user.accessRole === null
      ? new Set<string>(TOOL_DOMAINS)
      : new Set(user.accessRole.toolGrants.map((g) => g.domain));
  const toolDomains = [...TOOL_DOMAINS].filter(
    (d) => reachable.has(d) && featureDomains.has(d) && granted.has(d),
  );

  // ── locks ──
  const smartHomeOn = featureIds.has("smart_home");
  const locks =
    user.accessRole === null
      ? smartHomeOn && LOCK_CAPABLE_TIERS.has(tier)
      : user.accessRole.mayOperateLocks && smartHomeOn;

  // ── cloud AND-gate ──
  const cloud =
    user.accessRole === null
      ? inputs.cloudEscapeEnabled // today's workspace-only gate
      : inputs.cloudEscapeEnabled && user.accessRole.cloudModelsAllowed;

  // ── connectors[p] = min(grant, connection) ──
  const connectors: Record<string, ConnectorLevel> = {};
  // WARP-1579: the same grants, unclamped. Built in the SAME branch as the
  // min() so the two can never disagree about which rows exist.
  let connectorGrants: Record<string, ConnectorLevel> | null = null;
  if (user.accessRole === null) {
    // Today's floor: the connector routes gate owner/admin (O-2 widens
    // family reads only THROUGH a role grant, which a role-less user
    // cannot hold). No role ⇒ nothing narrows the axis ⇒ null, not {}.
    if (tier === "admin") {
      for (const [provider, level] of connLevels) connectors[provider] = level;
    }
  } else {
    connectorGrants = {};
    for (const grant of user.accessRole.connectorGrants) {
      // Reported whether or not a connection exists: the role's grant is a
      // statement of INTENT, and a box with nothing connected yet has not
      // thereby granted anything. (`connectors` still needs the connection.)
      connectorGrants[grant.provider] = grant.level;
      const connLevel = connLevels.get(grant.provider);
      if (!connLevel) continue; // no connection = no reach
      connectors[grant.provider] = minConnectorLevel(grant.level, connLevel);
    }
  }

  return {
    tier,
    features,
    toolDomains,
    locks,
    cloud,
    connectors,
    connectorGrants,
    usage: usageWire,
    deptRights: inputs.deptRights,
    exceptions: inputs.exceptions,
  };
}

// ── bound fetch wrapper (scope-loader shape) ───────────────────────

let boundPrisma: PrismaClient | null = null;
let boundConfig: AvailabilityConfig | null = null;

/**
 * Bind the orchestrator's PrismaClient + availability config at boot,
 * beside initScopeLoader (app.ts). Idempotent — same contract as
 * initScopeLoader / initActivityRecorder.
 */
export function initEffectiveAccess(prisma: PrismaClient, cfg: AvailabilityConfig): void {
  if (boundPrisma) return;
  boundPrisma = prisma;
  boundConfig = cfg;
}

/** Exposed only for tests — inject fakes or reset to null. */
export function _setEffectiveAccessForTests(
  prisma: PrismaClient | null,
  cfg: AvailabilityConfig | null,
): void {
  boundPrisma = prisma;
  boundConfig = cfg;
}

/**
 * Fetch-and-compose for a userId. Returns `null` when no such user (the
 * route maps it to 404). Throws when unwired — fail closed (a silent empty
 * result would 404/deny a legitimate person), the scope-loader posture.
 *
 * Every read below runs on the SAME `tx` handle (WARP-1583) — including
 * `getEffectiveModuleIds`, which is why that function takes a
 * `ModuleReadClient` rather than a `PrismaClient`. Reaching for `prisma`
 * anywhere inside this callback silently reopens the tear: it would take a
 * second snapshot, and the compose below would mix two instants again.
 */
export async function resolveEffectiveAccess(
  userId: string,
): Promise<EffectiveAccessResult | null> {
  const prisma = boundPrisma;
  const cfg = boundConfig;
  if (!prisma || !cfg) {
    throw new Error("effective-access resolver not initialised");
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        accessRole: {
          select: {
            mayOperateLocks: true,
            cloudModelsAllowed: true,
            storageQuotaBytes: true,
            maxUploadSizeMb: true,
            llmDailyMessageCap: true,
            featureGrants: { select: { moduleId: true, level: true } },
            toolGrants: { select: { domain: true, level: true } },
            connectorGrants: { select: { provider: true, level: true } },
          },
        },
      },
    });
    // Returning early is safe: the transaction commits having written
    // nothing, and the caller still gets the documented null.
    if (!user) return null;

    const [exceptions, workspaceModuleIds, cloudRow, connections, usagePolicy, memberships] =
      await Promise.all([
        tx.userAccessException.findMany({
          where: { userId },
          select: { id: true, moduleId: true, effect: true, level: true },
          orderBy: { createdAt: "asc" },
        }),
        getEffectiveModuleIds(tx, cfg),
        tx.offLanAllowlistChannel.findUnique({
          where: { key: "cloud_model_escape" },
          select: { enabled: true },
        }),
        tx.integrationConnection.findMany({
          select: { provider: true, writeEnabled: true },
        }),
        tx.userUsagePolicy.findUnique({
          where: { userId },
          select: {
            storageQuotaBytes: true,
            maxUploadSizeMb: true,
            llmDailyMessageCap: true,
          },
        }),
        tx.departmentMembership.findMany({
          where: { userId },
          select: { right: true, department: { select: { id: true, name: true, kind: true } } },
        }),
      ]);

    return computeEffectiveAccess({
      user: user as EffectiveAccessInputs["user"],
      exceptions: exceptions as AccessExceptionRow[],
      workspaceModuleIds,
      // Sovereignty read fails toward CLOSED: absent row = disabled (the
      // off-lan-gate.service posture).
      cloudEscapeEnabled: cloudRow?.enabled === true,
      connections,
      usagePolicy,
      deptRights: memberships.map((m) => ({
        id: m.department.id,
        name: m.department.name,
        // WARP-1809: the row's kind, verbatim — the client's display mapping
        // ("Workspace" for HOUSEHOLD) keys off this, never the name string.
        kind: m.department.kind,
        right: m.right,
      })),
    });
  }, REPEATABLE_READ_TX);
}
