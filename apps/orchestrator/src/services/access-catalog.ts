/**
 * WARP-1527 / ADR-032 (RBAC v2 T3) — the server-side §9 access catalog.
 *
 * ONE authoritative copy of the design brief's §9 permission model, rendered
 * onto the App-Modules `ModuleId` vocabulary (the T1 schema decision: one
 * feature vocabulary shared by the module registry, ModuleSetting rows, and
 * role grants — no parallel list to drift). Three consumers:
 *
 *   - the effective-access resolver (§3 `catalogFloor(tier)` clamp),
 *   - the /api/access/roles write paths (grants are re-clamped
 *     authoritatively at write time — the dashboard's copy in
 *     apps/web-dashboard/src/lib/access.ts only powers honest disabled
 *     states and is never trusted),
 *   - zod validation of grant/exception module ids.
 *
 * Floor model (ADR-004 via brief §9): `view` is never floored; `act`/
 * `manage` floor at the FAMILY tier on ordinary features; network and
 * managed-switch writes floor at ADMIN; voice `act` is deliberately
 * un-floored (guests may talk to the assistant). The always-on trio of the
 * design (home / chat / settings) contains exactly ONE module — `chat` —
 * which never produces a grant row (service-enforced floor, schema comment
 * on AccessRoleFeatureGrant); home and settings are dashboard surfaces, not
 * ModuleIds.
 *
 * Tool-domain axis: features map to tools-core `ToolDomain` values via the
 * module registry's `toolDomains` field. Domains NO module claims
 * (system / business / data / erp) are not module-gated and always pass the
 * feature intersection — matching how the shipped module-off drop treats
 * them. `erp` is additionally excluded from GRANTABLE_TOOL_DOMAINS:
 * connector reach is the §5.4 connectors axis (AccessRoleConnectorGrant),
 * never a tool grant.
 */
import type { ModuleId } from "@prisma/client";
import { TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import type { Role } from "./jwt.service.js";
import { MODULES } from "../modules/module-registry.js";

export type FeatureLevel = "view" | "act" | "manage";
export type ToolLevel = "view" | "use";
export type ConnectorLevel = "read" | "read_write";

/** view < act < manage — the §9 action ladder. */
export const FEATURE_LEVEL_RANK: Record<FeatureLevel, number> = {
  view: 0,
  act: 1,
  manage: 2,
};

/** The one always-on module (design's pinned trio minus the two non-module
 *  surfaces). Never a grant row; the resolver injects it. */
export const ALWAYS_ON_FEATURES: ReadonlyArray<{ moduleId: ModuleId; level: FeatureLevel }> = [
  { moduleId: "chat", level: "act" },
];

interface CatalogLevelDef {
  level: FeatureLevel;
  /** Minimum starting-point tier that may hold this level; absent = un-floored. */
  minTier?: "family" | "admin";
}

/**
 * §9 rendered onto ModuleId — value-identical to the dashboard's
 * ACCESS_FEATURES table (WARP-1532), minus copy. managed_switch offers no
 * `act` level by design (ports are view-or-configure).
 */
const CATALOG: Record<Exclude<ModuleId, "chat">, CatalogLevelDef[]> = {
  files: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  email: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  cameras: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  network: [
    { level: "view" },
    { level: "act", minTier: "admin" },
    { level: "manage", minTier: "admin" },
  ],
  smart_home: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  calendar: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  docs: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  knowledge: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  projects: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  // WARP-2117. Same ladder as `projects`, which it lives inside: `act` is
  // logging a call and moving a deal, `manage` is editing the pipeline itself.
  // Both floored at `family` — a pipeline is business-sensitive, so the guest
  // tier gets read-only or nothing.
  crm: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  // WARP-2018/2032. `manage` is where connecting an address-book SOURCE will
  // live (carddav-4), which is a credential-handling action; editing one's own
  // contacts is `act`.
  contacts: [
    { level: "view" },
    { level: "act", minTier: "family" },
    { level: "manage", minTier: "family" },
  ],
  voice: [
    { level: "view" },
    { level: "act" }, // un-floored — guests may talk to the assistant
    { level: "manage", minTier: "family" },
  ],
  managed_switch: [
    { level: "view" },
    { level: "manage", minTier: "admin" }, // no act level by design
  ],
  // WARP-1683 — Messages (team chat). `act` is un-floored like voice:
  // requireRole on /api/team-chat admits guests, so a guest may read AND
  // send. No `manage` level in v1 — there is no admin surface to manage.
  team_chat: [
    { level: "view" },
    { level: "act" },
  ],
};

/** The 12 grant-bearing ModuleIds (everything but the always-on chat). */
export const GATEABLE_MODULE_IDS = Object.keys(CATALOG) as ReadonlyArray<
  Exclude<ModuleId, "chat">
>;

export type GateableModuleId = Exclude<ModuleId, "chat">;

export function isGateableModuleId(v: string): v is GateableModuleId {
  return Object.prototype.hasOwnProperty.call(CATALOG, v);
}

/** The tier ladder for floor comparisons only — mirrors jwt.service ROLE_RANK
 *  ordering for the human tiers; `service` principals never resolve through
 *  the catalog (they keep their dedicated requireRoleOrService paths). */
const TIER_RANK: Record<Role, number> = {
  service: -1,
  guest: 0,
  family: 1,
  admin: 2,
  owner: 3,
};

function tierMayHold(tier: Role, def: CatalogLevelDef): boolean {
  if (!def.minTier) return true;
  return TIER_RANK[tier] >= TIER_RANK[def.minTier];
}

/**
 * The highest §9 level `tier` may hold on `moduleId`. Every module offers an
 * un-floored `view`, so the result is always at least "view" for a valid
 * gateable module.
 */
export function maxLevelFor(tier: Role, moduleId: GateableModuleId): FeatureLevel {
  const defs = CATALOG[moduleId];
  let best: FeatureLevel = "view";
  for (const def of defs) {
    if (tierMayHold(tier, def) && FEATURE_LEVEL_RANK[def.level] > FEATURE_LEVEL_RANK[best]) {
      best = def.level;
    }
  }
  return best;
}

/**
 * Clamp a requested grant level to the highest §9-legal level ≤ the request
 * for this tier — the server-side re-clamp of the dashboard's refloor
 * behavior. A level the module doesn't offer (managed_switch `act`) clamps
 * down the ladder to the nearest offered-and-held level.
 */
export function clampLevel(
  tier: Role,
  moduleId: GateableModuleId,
  requested: FeatureLevel,
): FeatureLevel {
  const defs = CATALOG[moduleId];
  let best: FeatureLevel = "view";
  for (const def of defs) {
    if (
      tierMayHold(tier, def) &&
      FEATURE_LEVEL_RANK[def.level] <= FEATURE_LEVEL_RANK[requested] &&
      FEATURE_LEVEL_RANK[def.level] > FEATURE_LEVEL_RANK[best]
    ) {
      best = def.level;
    }
  }
  return best;
}

/**
 * The tier's FULL catalog — what a person with `accessRoleId = null` holds
 * (today's world, bit-for-bit: the coarse ADR-004 floors keep enforcing at
 * layer 1; this is the §9 ceiling view of the same tier). Every gateable
 * module at the tier's max level, plus the always-on chat row.
 */
export function fullCatalogFeatures(
  tier: Role,
): Array<{ moduleId: ModuleId; level: FeatureLevel }> {
  const out: Array<{ moduleId: ModuleId; level: FeatureLevel }> = [
    ...ALWAYS_ON_FEATURES.map((f) => ({ ...f })),
  ];
  for (const moduleId of GATEABLE_MODULE_IDS) {
    out.push({ moduleId, level: maxLevelFor(tier, moduleId) });
  }
  return out;
}

// ── Connector axis (§5.4 / O-2 floors) ────────────────────────────

/**
 * Clamp a requested connector grant to what its starting point can actually
 * hold. `null` = the tier can hold NO grant on this axis at all, so the row
 * must not be written.
 *
 * The ONE authoritative statement of O-2's two connector floors, so the
 * builder's disabled options and the server's re-clamp can never drift:
 *
 *   • `read_write` is selectable only on **Admin-based** roles. A Family-based
 *     role caps at `read` — the ADR-032 §8 O-2 sentence, shipped in T6.
 *   • **Guest-based roles hold no connector grant at all** (WARP-1578). O-2's
 *     read floor is family-and-UP, and routes/erp.ts enforces the "and-up"
 *     half at the consumption site, so a grant stored on a Guest-based role is
 *     inert BY CONSTRUCTION — it can never widen anything. Keeping the row
 *     would let an operator save a setting that silently does nothing and
 *     would make the roles list advertise reach that does not exist. The
 *     builder shows the levels **disabled with the reason** (never hidden);
 *     this is the server half that makes the client's honesty enforceable.
 *
 * This clamp is WRITE-SIDE ONLY and ships with NO BACKFILL: guest connector
 * rows written before it exist until their role is next edited. It therefore
 * does NOT make `erpConnectorReadGate`'s family-and-up tier floor redundant —
 * that floor is what still neutralises those rows, and removing it on the
 * strength of this function would re-open PHI to them. Read the two together.
 *
 * Deliberately NOT a 400: the roles surface's contract is "the dashboard
 * pre-clamps for honest UI but is never trusted, and the server re-clamps"
 * (routes/access.ts header). Rejecting would break a contract every other
 * axis keeps.
 */
export function clampConnectorLevel(
  startingPoint: Role,
  requested: ConnectorLevel,
): ConnectorLevel | null {
  if (startingPoint === "admin" || startingPoint === "owner") return requested;
  // family (and anything else above guest) caps at read; guest holds none.
  if (startingPoint === "guest" || startingPoint === "service") return null;
  return requested === "read_write" ? "read" : requested;
}

// ── Tool-domain axis ──────────────────────────────────────────────

/** domain → owning module, from the ONE canonical module registry. */
const MODULE_BY_DOMAIN: ReadonlyMap<string, ModuleId> = new Map(
  MODULES.flatMap((def) => def.toolDomains.map((d) => [d, def.id] as const)),
);

/** Catalog domains no module claims — never module-gated. */
const UNCLAIMED_DOMAINS: ReadonlySet<string> = new Set(
  TOOL_DOMAINS.filter((d) => !MODULE_BY_DOMAIN.has(d)),
);

/**
 * §3 `moduleToolDomains(features)`: the tools-core domains reachable given
 * an effective feature set — claimed domains whose module is in the set,
 * plus every unclaimed domain (system / business / data / erp are not
 * feature-gated; their reach is governed by the other resolver axes).
 */
export function domainsForFeatures(featureIds: ReadonlySet<ModuleId>): Set<string> {
  const out = new Set<string>(UNCLAIMED_DOMAINS);
  for (const domain of TOOL_DOMAINS) {
    const owner = MODULE_BY_DOMAIN.get(domain);
    if (owner !== undefined && featureIds.has(owner)) out.add(domain);
  }
  return out;
}

/** Tool domains a role may write grant rows for — the catalog union minus
 *  `erp` (connector reach is the connectors axis, never a tool grant). */
export const GRANTABLE_TOOL_DOMAINS: ReadonlyArray<string> = TOOL_DOMAINS.filter(
  (d) => d !== "erp",
);

/**
 * §3 `writeFilter(tier)` at domain granularity: the domains that still
 * contain at least one tool after the shipped role write-filter
 * (routes/llm.ts narrowAllowedToolsForRole — owner/admin keep everything,
 * family/guest lose every `requiresWrite` tool). A domain whose every tool
 * is a write tool is unreachable for the family/guest tiers.
 */
export function tierReachableDomains(tier: Role): Set<string> {
  if (tier === "owner" || tier === "admin") {
    return new Set<string>(TOOL_DOMAINS);
  }
  const out = new Set<string>();
  for (const entry of TOOL_CATALOG) {
    if (!entry.requiresWrite) out.add(entry.domain);
  }
  return out;
}
