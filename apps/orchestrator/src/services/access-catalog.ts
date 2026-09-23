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
 * module registry's `toolDomains` field. A domain NO module claims passes the
 * feature intersection ONLY if it is declared in FEATURE_UNGATED_TOOL_DOMAINS
 * below, with a written reason; any other domain is DENIED (WARP-2742 — the
 * gate used to pass every unclaimed domain, which is how `money` and five
 * others slipped past it). `erp` is additionally excluded from
 * GRANTABLE_TOOL_DOMAINS: connector reach is the §5.4 connectors axis
 * (AccessRoleConnectorGrant), never a tool grant.
 */
import type { ModuleId } from "@prisma/client";
import { TOOL_CATALOG, TOOL_DOMAINS, type ToolDomain } from "@droplet/tools-core";
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
  // WARP-2977 (ADR-059 §6). `view` is the feed; `act` is acknowledging, the
  // expected/not-expected verdicts and the mode (P2b/P3); `manage` is zones,
  // links, schedule, suppressions, routing and retention. Presence data about
  // identifiable people, so even `view` is floored at family — no guest tier.
  // `manage` is business policy (a suppression can hide a real intrusion), so
  // it is floored at admin.
  security: [
    { level: "view", minTier: "family" },
    { level: "act", minTier: "family" },
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
  // WARP-2581. Money is READ-ONLY on this box — the vendor stays the system of
  // record — so there is no `act` level to offer: there is no action. `manage`
  // is floored at `admin` because the only management verb in reach is
  // connecting or disconnecting the ledger itself, which is credential work.
  money: [
    { level: "view", minTier: "family" },
    { level: "manage", minTier: "admin" },
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

/** The grant-bearing ModuleIds (everything but the always-on chat). */
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

/**
 * WARP-2742 — the tool domains that are DELIBERATELY not feature-gated, each
 * with the reason. The feature intersection is fail-CLOSED: a domain passes
 * `domainsForFeatures` only if its owning module (module-registry
 * `toolDomains`) is in the feature set, or it is listed here. A domain that is
 * neither — typically one a new tools-core slice just added — is denied to
 * every role-holder until someone decides which of the two it is, and
 * `access-catalog.test.ts` fails CI on it first.
 *
 * Before this, "ungated" was DERIVED from absence (any domain no module
 * claimed), so the set grew silently: `money` (whose module shipped with
 * `toolDomains: []`), `cloud`, `agent_runs` and `routines` all joined it
 * without anyone deciding they should. Listing is the decision.
 *
 * "Ungated" here means the FEATURE axis only. Every entry still clears the
 * tier write filter and the role's own tool grant (§3), and the routes behind
 * the tools keep their layer-1 guards. Owners and role-less users never reach
 * this function at all (tool-access.service.ts: null scope).
 */
export const FEATURE_UNGATED_TOOL_DOMAINS: Readonly<Partial<Record<ToolDomain, string>>> = {
  system:
    "Box health, drives, audit log, updates. No module owns the box itself; the tier " +
    "write filter strips apply_update below admin, and the routes behind the tools " +
    "(/api/updates, /api/storage, /api/activity, /api/hardware) keep their own guards.",
  data:
    "Pure utilities (calculate, encode, date math, unit/currency conversion, translate, " +
    "weather). They read no box or business data, so there is no feature to withhold.",
  agent_runs:
    "Durable background runs (WARP-2180). Not a module: it is the agent loop running " +
    "unattended, and /api/agent-runs is owner/admin-gated on the acting user (WARP-2742 comment " +
    "from the domain's author). The tool grant withholds the offer.",
  routines:
    "Stored ToolSpecs (WARP-2894). Not a module; every step a routine runs is re-checked " +
    "against this same scope by the ToolSpec runner (WARP-1580), so a routine reaches no " +
    "domain the role could not reach directly.",
  erp:
    "Connector reach is the §5.4 connectors axis (AccessRoleConnectorGrant), not a feature, " +
    "and erp is never a grantable tool domain.",
  business:
    "ADR-045's one door to the CRM and the tracker. Spans two modules (crm, projects); the " +
    "data is gated at /api/crm and /api/pm by the workspace module gate. OPEN (WARP-2742): " +
    "whether to require crm-or-projects per person is Romain's call.",
  cloud:
    "cloud_query_dataset (WARP-2497) reads connected SaaS accounts; /api/erp/dataset is " +
    "owner/admin-only on the resolved user and needs a live connection. OPEN (WARP-2742): " +
    "which feature, if any, should gate it is Romain's call; kept as-is until then.",
};

function isFeatureUngated(domain: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEATURE_UNGATED_TOOL_DOMAINS, domain);
}

/**
 * Tools-core domains with NO feature decision: no module claims them and they
 * are not declared ungated. Must be empty; the gate denies whatever is here.
 */
export function unmappedToolDomains(): string[] {
  return TOOL_DOMAINS.filter((d) => !MODULE_BY_DOMAIN.has(d) && !isFeatureUngated(d));
}

/**
 * §3 `moduleToolDomains(features)`: the tools-core domains reachable given
 * an effective feature set — claimed domains whose module is in the set,
 * plus the declared FEATURE_UNGATED_TOOL_DOMAINS. Everything else is denied.
 */
export function domainsForFeatures(featureIds: ReadonlySet<ModuleId>): Set<string> {
  const out = new Set<string>();
  for (const domain of TOOL_DOMAINS) {
    const owner = MODULE_BY_DOMAIN.get(domain);
    if (owner !== undefined ? featureIds.has(owner) : isFeatureUngated(domain)) out.add(domain);
  }
  return out;
}

/** Tool domains a role may write grant rows for — the catalog union minus
 *  `erp` (connector reach is the connectors axis, never a tool grant).
 *
 *  Derived, not listed, so a domain the catalog adds is grantable the same
 *  day — `business` (ADR-045) included, which is where every PM and CRM tool
 *  now lives. The dashboard's row table
 *  (apps/web-dashboard/src/lib/access.ts TOOL_DOMAIN_GROUPS) is the
 *  hand-kept half of that pair and has to move with it: WARP-2583's review
 *  found `business` filed under the System row there while the Projects row
 *  still wrote a grant for the emptied `pm`. Note `business` is declared
 *  FEATURE-UNGATED (no module owns it), which is precisely why the grant axis
 *  has to hold it: the module filter passes it unconditionally. */
export const GRANTABLE_TOOL_DOMAINS: ReadonlyArray<string> = TOOL_DOMAINS.filter(
  (d) => d !== "erp",
);

/**
 * §3 `writeFilter(tier)` at domain granularity: the domains that still
 * contain at least one tool after the shipped role write-filter
 * (routes/llm.ts narrowAllowedToolsForRole — owner/admin keep everything,
 * family/guest lose every `requiresWrite` tool). A domain whose every tool
 * is a write tool is unreachable for the family/guest tiers.
 *
 * AN EMPTY DOMAIN IS UNREACHABLE TOO, and that is a DIFFERENT statement this
 * function cannot tell apart from the one above: it adds a domain only on
 * FINDING a non-write tool in it, so a domain holding no tools at all reads
 * as "every tool here writes" when the truth is "no tool here yet". Today
 * that is `crm` and `pm` — ADR-045 slices C and D moved every CRM and PM tool
 * into `business`, and catalog.ts keeps the two declared but empty as the
 * landing slots for a remote catalog (HubSpot, Atlassian).
 *
 * WARP-2760/2761 resolved the collision that produced — five role templates
 * granting `crm` — by dropping those grants, NOT by returning empty domains
 * from here. This is a live term in the effective-access intersection
 * (effective-access.service.ts `reachable ∩ featureDomains ∩ granted`), so
 * widening it would leave family and guest holding a standing grant on every
 * toolless domain, and the FIRST tool a remote catalog registers into one may
 * be a write — the exact case this filter exists to catch. Deciding otherwise
 * is a change to the write filter and belongs in its own ticket;
 * `access-catalog.test.ts` pins the current answer so it cannot be reversed
 * by accident.
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
