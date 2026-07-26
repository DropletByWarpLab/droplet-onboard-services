/**
 * WARP-1532 (RBAC v2 T8) — pure domain logic for the Roles & access UI.
 *
 * The catalog here renders the design brief's §9 permission model onto the
 * MERGED T1 vocabulary (WARP-1525): feature grants are keyed by the
 * App-Modules `ModuleId` pgEnum — one feature vocabulary, no drift. The
 * three always-on areas (home / chat / settings) render as pinned rows but
 * NEVER produce grant rows (the always-on floor is service-enforced, not a
 * row — schema comment on AccessRoleFeatureGrant). Design-§9 areas that are
 * not modules (tools / activity / people / models) are intentionally absent:
 * they cannot be persisted in the merged contract. See the ticket handoff
 * notes for the deviation record.
 *
 * Floor model (ADR-004 via brief §9): `view` is never floored; `act`/`manage`
 * need the family tier on ordinary features; network + managed-switch writes
 * are admin-and-up. The server (T3) re-clamps authoritatively — this module
 * only powers the honest disabled-with-reason rendering (§5.2) and the
 * re-floor notices (§5.1). The client is never trusted.
 */
import type {
  AccessModuleId,
  AccessRole,
  AccessRolePayload,
  AccessRoleToolGrant,
  AccessStartingPoint,
  AccessTier,
  ConnectorAccessLevel,
  FeatureAccessLevel,
  ToolAccessLevel,
} from "./types";
import { ACCESS_COPY } from "@/components/access/copy";
import { bytesToStorageInput, storageInputToBytes } from "./storage-units";
import type { StorageUnit } from "./storage-units";

// ── Tier ladder + display labels ──────────────────────────────────────────

/** ADR-004 rank ladder (mirrors jwt.service.ts ROLE_RANK). `service` is a
 *  system principal, never comparable for assignment — rank 0. */
export const TIER_RANK: Record<AccessTier, number> = {
  service: 0,
  guest: 1,
  family: 2,
  admin: 3,
  owner: 4,
};

/** Display label — the ONE place the `family` → "Staff" relabel lives
 *  (§0.1 / O-1). The enum value never changes. */
export function tierLabel(tier: AccessTier): string {
  switch (tier) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "family":
      return "Staff";
    case "guest":
      return "Guest";
    case "service":
      return "Service";
  }
}

/** Lower-case plural for sentence positions ("…are for admins."). "Staff"
 *  is its own plural — never "staffs". */
export function tierPlural(tier: AccessTier): string {
  switch (tier) {
    case "owner":
      return "owners";
    case "admin":
      return "admins";
    case "family":
      return "staff";
    case "guest":
      return "guests";
    case "service":
      return "service identities";
  }
}

// ── Feature catalog (§9 rendered onto the ModuleId vocabulary) ─────────────

export interface AccessLevelDef {
  value: FeatureAccessLevel;
  /** Feature-specific option label ("Export clips", "Configure"). */
  label: string;
  /** caption-1 line naming exactly what the level grants. */
  grants: string;
  /** ADR-004 floor — the minimum starting point that may hold this level. */
  minTier?: "family" | "admin";
  /** Noun phrase for the re-floor notice ("Configure network"). */
  dropNoun?: string;
  /** Verb phrase for the re-floor notice ("change the network"). */
  dropVerb?: string;
}

export interface AccessFeatureDef {
  /** ModuleId for gateable rows; "home"/"settings" only on pinned rows. */
  moduleId: AccessModuleId | "home" | "settings";
  label: string;
  description: string;
  /** Pinned always-on rows (§5.2): toggle rendered on + disabled. */
  alwaysOn?: boolean;
  /** Tooltip for the disabled always-on toggle (§12). */
  alwaysOnReason?: string;
  /** Files defers per-library rights to Departments & teams (ADR-029). */
  filesReference?: boolean;
  /** Smart-home carries the "May operate locks" sub-toggle (§5.2). */
  locks?: boolean;
  /** Verbatim floor reason for admin-floored features (§12 pattern). */
  floorReason?: string;
  /**
   * WARP-1585 — the module this feature cannot function without. Mirrors the
   * orchestrator registry's `ModuleDef.requires`, which is the authority: the
   * §3 resolver drops a feature whose parent the person does not hold, and
   * this copy exists only so the panel can say so BEFORE they save.
   *
   * A dependency is not a grouping. The bar is that the child has no reachable
   * surface without the parent — `docs` clears it (its editor sessions are
   * minted on Nextcloud paths, and its only entry point is the Files preview
   * pane); `knowledge` deliberately does NOT (it reads the box's own chunk
   * store behind the file indexer, and has its own page).
   */
  requires?: AccessModuleId;
  /** The honest reason shown on the blocked row — never a bare "unavailable". */
  requiresReason?: string;
  levels: AccessLevelDef[];
}

const FAMILY = "family" as const;
const ADMIN = "admin" as const;

export const ACCESS_FEATURES: AccessFeatureDef[] = [
  {
    moduleId: "home",
    label: "Home",
    description: "The overview everyone lands on",
    alwaysOn: true,
    alwaysOnReason: ACCESS_COPY.homeAlwaysOn,
    levels: [{ value: "view", label: "View", grants: "See the overview" }],
  },
  {
    moduleId: "chat",
    label: "Chat",
    description: "The always-on assistant",
    alwaysOn: true,
    alwaysOnReason: ACCESS_COPY.chatAlwaysOn,
    levels: [{ value: "act", label: "Use chat", grants: "Send messages and use the assistant" }],
  },
  {
    moduleId: "files",
    label: "Files",
    description: "Personal and shared libraries",
    filesReference: true,
    levels: [
      { value: "view", label: "See & download", grants: "See and download files" },
      {
        value: "act",
        label: "Edit",
        grants: "Upload, edit, move, delete",
        minTier: FAMILY,
        dropNoun: "Edit files",
        dropVerb: "edit files",
      },
      {
        value: "manage",
        label: "Share & manage",
        grants: "Share and manage members",
        minTier: FAMILY,
        dropNoun: "Share & manage files",
        dropVerb: "share files",
      },
    ],
  },
  {
    moduleId: "email",
    label: "Email",
    description: "Their mailbox",
    levels: [
      { value: "view", label: "Read", grants: "Read the mailbox" },
      {
        value: "act",
        label: "Compose & send",
        grants: "Compose, reply, and send",
        minTier: FAMILY,
        dropNoun: "Compose & send",
        dropVerb: "send email",
      },
      {
        value: "manage",
        label: "Manage account",
        grants: "Account, filters, rules, signature",
        minTier: FAMILY,
        dropNoun: "Manage email account",
        dropVerb: "manage the mailbox",
      },
    ],
  },
  {
    moduleId: "cameras",
    label: "Cameras",
    description: "Live view, events and clips",
    levels: [
      { value: "view", label: "View live", grants: "Live view, events, snapshots" },
      {
        value: "act",
        label: "Export clips",
        grants: "Everything in View, plus export clips",
        minTier: FAMILY,
        dropNoun: "Export clips",
        dropVerb: "export clips",
      },
      {
        value: "manage",
        label: "Configure cameras",
        grants: "Scan, accept, and set subnets",
        minTier: FAMILY,
        dropNoun: "Configure cameras",
        dropVerb: "configure cameras",
      },
    ],
  },
  {
    moduleId: "network",
    label: "Network",
    description: "Router, Wi-Fi and devices",
    floorReason: ACCESS_COPY.floorBlockedNetwork,
    levels: [
      { value: "view", label: "View", grants: "Status, Wi-Fi, and device list" },
      {
        value: "act",
        label: "Supervise",
        grants: "Rename/block devices, SSID, guest Wi-Fi",
        minTier: ADMIN,
        dropNoun: "Supervise network",
        dropVerb: "supervise the network",
      },
      {
        value: "manage",
        label: "Configure",
        grants: "Firewall, VLANs, port-forwards, static DHCP",
        minTier: ADMIN,
        dropNoun: "Configure network",
        dropVerb: "change the network",
      },
    ],
  },
  {
    moduleId: "smart_home",
    label: "Devices",
    description: "Smart-home devices and rooms",
    locks: true,
    levels: [
      { value: "view", label: "View", grants: "Devices and history" },
      {
        value: "act",
        label: "Control",
        grants: "On/off, brightness",
        minTier: FAMILY,
        dropNoun: "Control devices",
        dropVerb: "control devices",
      },
      {
        value: "manage",
        label: "Add & organize",
        grants: "Commission devices, organize rooms",
        minTier: FAMILY,
        dropNoun: "Add & organize devices",
        dropVerb: "commission devices",
      },
    ],
  },
  {
    moduleId: "calendar",
    label: "Calendar",
    description: "Calendars, events and reminders",
    levels: [
      { value: "view", label: "View", grants: "See calendars and events" },
      {
        value: "act",
        label: "Edit",
        grants: "Create and edit events and reminders",
        minTier: FAMILY,
        dropNoun: "Edit calendar",
        dropVerb: "edit the calendar",
      },
      {
        value: "manage",
        label: "Manage calendars",
        grants: "Share and manage calendars",
        minTier: FAMILY,
        dropNoun: "Manage calendars",
        dropVerb: "manage calendars",
      },
    ],
  },
  {
    moduleId: "docs",
    label: "Documents",
    description: "Shared documents and editing",
    requires: "files",
    requiresReason: ACCESS_COPY.docsNeedsFiles,
    levels: [
      { value: "view", label: "View", grants: "Open and read documents" },
      {
        value: "act",
        label: "Edit",
        grants: "Create and edit documents",
        minTier: FAMILY,
        dropNoun: "Edit documents",
        dropVerb: "edit documents",
      },
      {
        value: "manage",
        label: "Manage",
        grants: "Share and organize documents",
        minTier: FAMILY,
        dropNoun: "Manage documents",
        dropVerb: "manage documents",
      },
    ],
  },
  {
    moduleId: "knowledge",
    label: "Knowledge",
    description: "The box's knowledge base",
    levels: [
      { value: "view", label: "View", grants: "Browse the knowledge base" },
      {
        value: "act",
        label: "Contribute",
        grants: "Add and edit entries",
        minTier: FAMILY,
        dropNoun: "Contribute knowledge",
        dropVerb: "edit the knowledge base",
      },
      {
        value: "manage",
        label: "Manage",
        grants: "Organize and remove entries",
        minTier: FAMILY,
        dropNoun: "Manage knowledge",
        dropVerb: "manage the knowledge base",
      },
    ],
  },
  {
    moduleId: "projects",
    label: "Projects",
    description: "Boards, tasks and milestones",
    levels: [
      { value: "view", label: "View", grants: "See boards and tasks" },
      {
        value: "act",
        label: "Work",
        grants: "Create and update tasks",
        minTier: FAMILY,
        dropNoun: "Work on projects",
        dropVerb: "update tasks",
      },
      {
        value: "manage",
        label: "Manage",
        grants: "Create projects, manage members",
        minTier: FAMILY,
        dropNoun: "Manage projects",
        dropVerb: "manage projects",
      },
    ],
  },
  {
    moduleId: "voice",
    label: "Voice",
    description: "Talking to the assistant out loud",
    levels: [
      { value: "view", label: "View", grants: "See voice status" },
      { value: "act", label: "Use voice", grants: "Talk to the assistant by voice" },
      {
        value: "manage",
        label: "Manage",
        grants: "Enroll speakers, calibrate the mic",
        minTier: FAMILY,
        dropNoun: "Manage voice",
        dropVerb: "manage voice settings",
      },
    ],
  },
  {
    moduleId: "managed_switch",
    label: "Managed switch",
    description: "Switch ports and PoE",
    floorReason: "Switch changes are for admins.",
    levels: [
      { value: "view", label: "View", grants: "Ports and status" },
      {
        value: "manage",
        label: "Configure",
        grants: "Port config, PoE, VLAN membership",
        minTier: ADMIN,
        dropNoun: "Configure switch",
        dropVerb: "change the switch",
      },
    ],
  },
  {
    moduleId: "settings",
    label: "Settings",
    description: "Preferences and workspace config",
    alwaysOn: true,
    alwaysOnReason: ACCESS_COPY.settingsAlwaysOn,
    levels: [{ value: "view", label: "Own settings", grants: "Edit own profile and preferences" }],
  },
];

/** The rows that can produce grant rows (everything except the pinned trio). */
export const GATEABLE_FEATURES: AccessFeatureDef[] = ACCESS_FEATURES.filter((f) => !f.alwaysOn);

export function featureDef(moduleId: string): AccessFeatureDef | undefined {
  return ACCESS_FEATURES.find((f) => f.moduleId === moduleId);
}

// ── On-box tool domains (§5.4, tools-core vocabulary) ─────────────────────

export interface ToolDomainGroup {
  /** Stable group id (draft key). */
  id: string;
  /** Row label — the design's grouping language. */
  label: string;
  /** tools-core ToolDomain values this row writes grant rows for. */
  domains: string[];
  /** Gateable feature that auto-offs this row when disabled; null = none. */
  feature: AccessModuleId | null;
  /** Smart-home row carries the locks note (§5.2/§5.4). */
  locks?: boolean;
}

/** Every tools-core domain exactly once, EXCEPT `erp` — connector reach is
 *  the §5.4 connectors block (AccessRoleConnectorGrant), not a tool grant. */
export const TOOL_DOMAIN_GROUPS: ToolDomainGroup[] = [
  { id: "network", label: "Network", domains: ["network"], feature: "network" },
  { id: "files", label: "Files", domains: ["files"], feature: "files" },
  { id: "smart-home", label: "Smart-home", domains: ["smart-home"], feature: "smart_home", locks: true },
  { id: "cameras", label: "Cameras", domains: ["cameras"], feature: "cameras" },
  { id: "switch", label: "Switch", domains: ["switch"], feature: "managed_switch" },
  {
    id: "calendar",
    label: "Calendar, reminders & notifications",
    domains: ["calendar", "reminders", "notifications"],
    feature: "calendar",
  },
  { id: "email", label: "Email", domains: ["email"], feature: "email" },
  { id: "projects", label: "Projects", domains: ["pm"], feature: "projects" },
  { id: "memory", label: "Memory", domains: ["memory"], feature: "knowledge" },
  { id: "system", label: "System", domains: ["system", "business", "data"], feature: null },
];

// ── Floor clamping ─────────────────────────────────────────────────────────

/** True when `level` on `featureId` exceeds what `sp` may hold (§5.2). */
export function isLevelBlocked(
  sp: AccessStartingPoint,
  featureId: string,
  level: FeatureAccessLevel,
): boolean {
  const feature = featureDef(featureId);
  const def = feature?.levels.find((l) => l.value === level);
  if (!def?.minTier) return false;
  return TIER_RANK[sp] < TIER_RANK[def.minTier];
}

/** The honest disabled reason for a floor-blocked level. Network (and the
 *  switch) carry their §12-verbatim feature-wide reason; everything else
 *  uses the "{Thing} is for {tier}s." pattern. */
export function floorBlockedReason(featureId: string, level: FeatureAccessLevel): string {
  const feature = featureDef(featureId);
  const def = feature?.levels.find((l) => l.value === level);
  if (!feature || !def?.minTier) return "";
  if (feature.floorReason) return feature.floorReason;
  return `${def.dropNoun ?? def.label} is for ${tierPlural(def.minTier)}.`;
}

// ── Role draft (what the builder edits) ────────────────────────────────────

export interface FeatureDraftEntry {
  on: boolean;
  level: FeatureAccessLevel;
}

export type FeatureDraft = Record<string, FeatureDraftEntry>;

/**
 * WARP-1585 — is `feature` blocked because its declared parent is off in this
 * draft? Returns the honest reason, or null when nothing blocks it.
 *
 * READ-ONLY on the draft, and that is the point. Blocking is a rendering
 * decision, never an edit: the T8 convention is that a draft never re-emits a
 * DERIVED value for an axis the operator did not touch, and silently clearing
 * the Documents grant when Files goes off would revoke a second thing on their
 * behalf — which is the exact failure this ticket exists to remove. The
 * operator's Documents intent survives the round-trip, the row explains why it
 * isn't in effect, and the §3 resolver is the authority that enforces it.
 */
export function dependencyBlockedReason(
  features: FeatureDraft,
  feature: AccessFeatureDef,
): string | null {
  const parent = feature.requires;
  if (!parent) return null;
  if (features[parent]?.on) return null;
  return feature.requiresReason ?? null;
}

export interface RoleUsageDraft {
  storageValue: string;
  storageUnit: StorageUnit;
  uploadMb: string;
  llmDaily: string;
}

export interface RoleDraft {
  id: string | null;
  name: string;
  slug: string;
  description: string;
  startingPoint: AccessStartingPoint;
  features: FeatureDraft;
  /** Keyed by TOOL_DOMAIN_GROUPS id — the group select's DISPLAY value.
   *  Only groups listed in `touchedToolGroups` write from this map. */
  tools: Record<string, ToolAccessLevel>;
  /** The server's tool-grant rows VERBATIM (edit mode; empty on create).
   *  Untouched groups re-emit these rows exactly — a group select is a
   *  lossy view over per-domain rows, so an untouched save must never
   *  widen mixed levels or invent rows where the schema says absent=OFF. */
  originalToolGrants: AccessRoleToolGrant[];
  /** Group ids the admin explicitly set THIS session; only these fan out.
   *  Create mode marks every group touched (the blank builder's selects
   *  are the source of truth for a brand-new role). */
  touchedToolGroups: string[];
  /** Keyed by connector provider; "none" = no grant row. */
  connectors: Record<string, ConnectorAccessLevel | "none">;
  usage: RoleUsageDraft;
  /** The server's usage values VERBATIM (edit mode; nulls on create).
   *  The GB/TB input is a lossy view over a byte string — re-parsing an
   *  untouched display value drifted non-whole-GB quotas (~20 MB on a 1.2 TB
   *  value) and NULLED sub-0.05-GB quotas entirely (review F2). Untouched
   *  saves re-emit these raw values exactly. */
  originalUsage: {
    storageQuotaBytes: string | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
  };
  /** True once the admin edits ANY usage field this session; only then do
   *  the input values become the payload source. Create mode starts true
   *  (the blank fields are the truth for a new role). */
  usageTouched: boolean;
  cloud: boolean;
  locks: boolean;
}

/** Sensible defaults per starting point: everything on at its first (view)
 *  level, except network which starts OFF below the admin tier — matching
 *  the packet's fixtures and the "narrow within the floor" mental model. */
export function defaultFeatureDraft(sp: AccessStartingPoint): FeatureDraft {
  const draft: FeatureDraft = {};
  for (const f of ACCESS_FEATURES) {
    const level = f.levels[0]!.value;
    const on = f.moduleId === "network" ? sp === "admin" : true;
    draft[f.moduleId] = { on: f.alwaysOn ? true : on, level };
  }
  return draft;
}

export function blankRoleDraft(sp: AccessStartingPoint = "family"): RoleDraft {
  const tools: Record<string, ToolAccessLevel> = {};
  for (const g of TOOL_DOMAIN_GROUPS) tools[g.id] = "view";
  return {
    id: null,
    name: "",
    slug: "",
    description: "",
    startingPoint: sp,
    features: defaultFeatureDraft(sp),
    tools,
    originalToolGrants: [],
    // Create mode: no server rows exist, so the builder's selects ARE the
    // truth — every group is explicit and fans out on save.
    touchedToolGroups: TOOL_DOMAIN_GROUPS.map((g) => g.id),
    connectors: {},
    usage: { storageValue: "", storageUnit: "GB", uploadMb: "", llmDaily: "" },
    originalUsage: { storageQuotaBytes: null, maxUploadSizeMb: null, llmDailyMessageCap: null },
    usageTouched: true,
    cloud: false,
    locks: false,
  };
}

/** Pull every over-floor level back to the feature's base level and name the
 *  FIRST dropped grant with the §12 notice pattern — never a silent change. */
export function refloorFeatures(
  features: FeatureDraft,
  sp: AccessStartingPoint,
): { features: FeatureDraft; notice: string | null } {
  const next: FeatureDraft = {};
  let notice: string | null = null;
  for (const f of ACCESS_FEATURES) {
    const cur = features[f.moduleId] ?? { on: !f.alwaysOn ? false : true, level: f.levels[0]!.value };
    if (f.alwaysOn || !isLevelBlocked(sp, f.moduleId, cur.level)) {
      next[f.moduleId] = { ...cur };
      continue;
    }
    const dropped = f.levels.find((l) => l.value === cur.level);
    next[f.moduleId] = { ...cur, level: f.levels[0]!.value };
    if (!notice && dropped) {
      notice = `Switching to ${tierLabel(sp)} turns off ${dropped.dropNoun ?? dropped.label} — ${tierPlural(
        sp,
      )} can't ${dropped.dropVerb ?? `do that`}.`;
    }
  }
  return { features: next, notice };
}

// ── Slug + storage formatting (BigInt strings, never lossy) ───────────────

/** Client-side preview only — the server owns the authoritative slug. */
export function slugifyRoleName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Storage sizing is shared with the people + departments surfaces, so the
 *  bytes ⇄ unit contract lives in one module (WARP-1561). Re-exported here
 *  because the access components import it from `@/lib/access` — and because
 *  the three former copies disagreed in ways that cost this panel a quota-
 *  drift bug (see `storage-units.ts` for the rounding policy). */
export {
  STORAGE_UNIT_BYTES,
  formatStorageBytes,
  storageInputToBytes,
  bytesToStorageInput,
} from "./storage-units";
export type { StorageUnit };

// ── Connectors (O-2 floors) ────────────────────────────────────────────────

/** Every connector level, in ladder order. The builder RENDERS all of them —
 *  §5.2's "shown, never hidden" — and disables the ones the starting point
 *  cannot hold, exactly like the feature-level pills. */
export const CONNECTOR_LEVELS: ReadonlyArray<ConnectorAccessLevel | "none"> = [
  "none",
  "read",
  "read_write",
];

/**
 * SELECTABLE connector levels for a starting point. Mirrors the server's
 * `clampConnectorLevel` (access-catalog.ts), which re-clamps regardless.
 *
 *   • Admin  — both levels. O-2: Read & write is Admin-only.
 *   • Family — caps at Read.
 *   • Guest  — none at all (WARP-1578). O-2's read floor is family-and-UP and
 *     routes/erp.ts refuses a guest at the tier floor before the resolver is
 *     even consulted, so a grant here is inert by construction. Offering it
 *     would let an operator save a setting that silently does nothing.
 */
export function connectorLevelsFor(
  sp: AccessStartingPoint,
): Array<ConnectorAccessLevel | "none"> {
  if (sp === "admin") return ["none", "read", "read_write"];
  if (sp === "guest") return ["none"];
  return ["none", "read"];
}

/** The honest disabled reason for whatever this starting point cannot hold on
 *  the connectors axis — the §12 `{Thing} is for {tier}s.` pattern, the same
 *  shape as `floorBlockedReason`. `null` when nothing is blocked. */
export function connectorFloorReason(sp: AccessStartingPoint): string | null {
  if (sp === "guest") return `Connectors are for ${tierPlural("family")} and admins.`;
  if (sp === "admin") return null;
  return "Read & write is for admins.";
}

/** True when this starting point holds NO connector grant at all — the axis,
 *  not just a level, is floor-blocked. */
export function connectorAxisBlocked(sp: AccessStartingPoint): boolean {
  return connectorLevelsFor(sp).every((level) => level === "none");
}

// ── Draft ⇄ wire ───────────────────────────────────────────────────────────

/** Draft → POST/PATCH body. Absent row = OFF: only enabled gateable features
 *  emit grants; always-on rows never do; feature-off tool domains drop; a
 *  connector write grant is clamped to read on non-admin starting points. */
export function draftToRolePayload(draft: RoleDraft): AccessRolePayload {
  const featureGrants = GATEABLE_FEATURES.filter((f) => draft.features[f.moduleId]?.on).map(
    (f) => {
      const entry = draft.features[f.moduleId]!;
      const level = isLevelBlocked(draft.startingPoint, f.moduleId, entry.level)
        ? f.levels[0]!.value
        : entry.level;
      return { moduleId: f.moduleId as AccessModuleId, level };
    },
  );

  // Tool grants — QA send-back: the group select is a LOSSY view over the
  // per-domain rows, so only groups the admin explicitly touched fan out;
  // every other original row passes through verbatim. Never widen a mixed
  // group, never invent rows for a zero-row group (absent row = OFF), and
  // never drop rows for domains outside the grouped list (e.g. erp).
  const touched = new Set(draft.touchedToolGroups);
  const groupByDomain = new Map<string, ToolDomainGroup>();
  for (const g of TOOL_DOMAIN_GROUPS) {
    for (const domain of g.domains) groupByDomain.set(domain, g);
  }
  const toolGrants: AccessRoleToolGrant[] = [];
  for (const g of TOOL_DOMAIN_GROUPS) {
    if (!touched.has(g.id)) continue;
    if (g.feature && !draft.features[g.feature]?.on) continue;
    const level = draft.tools[g.id] ?? "view";
    for (const domain of g.domains) toolGrants.push({ domain, level });
  }
  for (const row of draft.originalToolGrants) {
    const group = groupByDomain.get(row.domain);
    if (group && touched.has(group.id)) continue; // superseded by the fan-out
    if (group?.feature && !draft.features[group.feature]?.on) continue; // auto-off
    toolGrants.push({ domain: row.domain, level: row.level });
  }

  // Connectors — the O-2 floors, mirroring the server's clampConnectorLevel.
  // A Guest-based role emits NO grant (WARP-1578): the server drops these
  // unconditionally, so emitting them would make the sheet show a value the
  // very next GET contradicts. The sheet discloses the removal rather than
  // performing it silently.
  const connectorAllowed = new Set(connectorLevelsFor(draft.startingPoint));
  const connectorGrants = connectorAxisBlocked(draft.startingPoint)
    ? []
    : Object.entries(draft.connectors)
        .filter(([, level]) => level !== "none")
        .map(([provider, level]) => ({
          provider,
          level: (connectorAllowed.has(level)
            ? level
            : "read") as ConnectorAccessLevel,
        }));

  // Usage — same untouched-verbatim rule as the tool axis (review F2):
  // the GB/TB input is lossy, so its parsed value only becomes the payload
  // once the admin actually edited a usage field; otherwise the server's
  // raw values re-emit exactly (no float drift, no silent quota removal).
  const uploadTrimmed = draft.usage.uploadMb.trim();
  const uploadN = Number(uploadTrimmed);
  const llmTrimmed = draft.usage.llmDaily.trim();
  const llmN = Number(llmTrimmed);
  const usage = draft.usageTouched
    ? {
        storageQuotaBytes: storageInputToBytes(draft.usage.storageValue, draft.usage.storageUnit),
        maxUploadSizeMb:
          uploadTrimmed && Number.isInteger(uploadN) && uploadN > 0 ? uploadN : null,
        llmDailyMessageCap: llmTrimmed && Number.isInteger(llmN) && llmN > 0 ? llmN : null,
      }
    : { ...draft.originalUsage };

  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    startingPoint: draft.startingPoint,
    ...usage,
    cloudModelsAllowed: draft.cloud,
    mayOperateLocks: draft.locks && !!draft.features.smart_home?.on,
    featureGrants,
    toolGrants,
    connectorGrants,
  };
}

/** Wire role → editable draft (edit + duplicate modes). */
export function roleToDraft(role: AccessRole): RoleDraft {
  const features: FeatureDraft = {};
  for (const f of ACCESS_FEATURES) {
    if (f.alwaysOn) {
      features[f.moduleId] = { on: true, level: f.levels[0]!.value };
      continue;
    }
    const grant = role.featureGrants.find((g) => g.moduleId === f.moduleId);
    features[f.moduleId] = grant
      ? { on: true, level: grant.level }
      : { on: false, level: f.levels[0]!.value };
  }

  const tools: Record<string, ToolAccessLevel> = {};
  for (const g of TOOL_DOMAIN_GROUPS) {
    const grants = role.toolGrants.filter((t) => g.domains.includes(t.domain));
    // DISPLAY value only: a group select shows the widest of its domains'
    // levels. The save path ignores this map for untouched groups — the
    // original rows pass through verbatim (see draftToRolePayload), so the
    // lossy display can never widen or invent grants.
    tools[g.id] = grants.some((t) => t.level === "use") ? "use" : "view";
  }

  const connectors: Record<string, ConnectorAccessLevel | "none"> = {};
  for (const c of role.connectorGrants) connectors[c.provider] = c.level;

  const { value: storageValue, unit: storageUnit } = bytesToStorageInput(role.storageQuotaBytes);

  return {
    id: role.id,
    name: role.name,
    slug: role.slug,
    description: role.description ?? "",
    startingPoint: role.startingPoint,
    features,
    tools,
    originalToolGrants: role.toolGrants.map((t) => ({ domain: t.domain, level: t.level })),
    touchedToolGroups: [],
    connectors,
    usage: {
      storageValue,
      storageUnit,
      uploadMb: role.maxUploadSizeMb != null ? String(role.maxUploadSizeMb) : "",
      llmDaily: role.llmDailyMessageCap != null ? String(role.llmDailyMessageCap) : "",
    },
    originalUsage: {
      storageQuotaBytes: role.storageQuotaBytes,
      maxUploadSizeMb: role.maxUploadSizeMb,
      llmDailyMessageCap: role.llmDailyMessageCap,
    },
    usageTouched: false,
    cloud: role.cloudModelsAllowed,
    locks: role.mayOperateLocks,
  };
}
