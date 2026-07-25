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
  AccessStartingPoint,
  AccessTier,
  ConnectorAccessLevel,
  FeatureAccessLevel,
  ToolAccessLevel,
} from "./types";
import { ACCESS_COPY } from "@/components/access/copy";

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
  /** Keyed by TOOL_DOMAIN_GROUPS id. */
  tools: Record<string, ToolAccessLevel>;
  /** Keyed by connector provider; "none" = no grant row. */
  connectors: Record<string, ConnectorAccessLevel | "none">;
  usage: RoleUsageDraft;
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
    connectors: {},
    usage: { storageValue: "", storageUnit: "GB", uploadMb: "", llmDaily: "" },
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

export const STORAGE_UNIT_BYTES = { GB: 1024 ** 3, TB: 1024 ** 4 } as const;
export type StorageUnit = keyof typeof STORAGE_UNIT_BYTES;
const MB_BYTES = 1024 ** 2;

/** Byte count (decimal string per the wire contract) → short human size.
 *  Unknown/invalid → "—", never a fabricated 0 (§10: unknown renders —). */
export function formatStorageBytes(value: string | null | undefined): string {
  if (value == null) return ACCESS_COPY.unknownValue;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return ACCESS_COPY.unknownValue;
  if (n >= STORAGE_UNIT_BYTES.TB && n % STORAGE_UNIT_BYTES.TB === 0) {
    return `${n / STORAGE_UNIT_BYTES.TB} TB`;
  }
  if (n >= STORAGE_UNIT_BYTES.GB) {
    const gb = n / STORAGE_UNIT_BYTES.GB;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(n / MB_BYTES)} MB`;
}

/** Admin-typed "{value} {unit}" → decimal byte string; empty/invalid → null
 *  (= no limit). Round-trips exactly for the whole-GB/TB values admins type. */
export function storageInputToBytes(value: string, unit: StorageUnit): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * STORAGE_UNIT_BYTES[unit]));
}

/** Byte string → the {value, unit} pair the numeric+unit control edits. */
export function bytesToStorageInput(bytes: string | null): { value: string; unit: StorageUnit } {
  if (bytes == null) return { value: "", unit: "GB" };
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return { value: "", unit: "GB" };
  if (n >= STORAGE_UNIT_BYTES.TB && n % STORAGE_UNIT_BYTES.TB === 0) {
    return { value: String(n / STORAGE_UNIT_BYTES.TB), unit: "TB" };
  }
  return { value: String(Math.round((n / STORAGE_UNIT_BYTES.GB) * 10) / 10), unit: "GB" };
}

// ── Connectors (O-2 floor) ─────────────────────────────────────────────────

/** Selectable connector levels for a starting point — Read & write is only
 *  offered on Admin-based roles (O-2); the server re-clamps regardless. */
export function connectorLevelsFor(
  sp: AccessStartingPoint,
): Array<ConnectorAccessLevel | "none"> {
  return sp === "admin" ? ["none", "read", "read_write"] : ["none", "read"];
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

  const toolGrants = TOOL_DOMAIN_GROUPS.flatMap((g) => {
    if (g.feature && !draft.features[g.feature]?.on) return [];
    const level = draft.tools[g.id] ?? "view";
    return g.domains.map((domain) => ({ domain, level }));
  });

  const connectorGrants = Object.entries(draft.connectors)
    .filter(([, level]) => level !== "none")
    .map(([provider, level]) => ({
      provider,
      level:
        level === "read_write" && draft.startingPoint !== "admin"
          ? ("read" as ConnectorAccessLevel)
          : (level as ConnectorAccessLevel),
    }));

  const uploadTrimmed = draft.usage.uploadMb.trim();
  const uploadN = Number(uploadTrimmed);
  const llmTrimmed = draft.usage.llmDaily.trim();
  const llmN = Number(llmTrimmed);

  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    startingPoint: draft.startingPoint,
    storageQuotaBytes: storageInputToBytes(draft.usage.storageValue, draft.usage.storageUnit),
    maxUploadSizeMb:
      uploadTrimmed && Number.isInteger(uploadN) && uploadN > 0 ? uploadN : null,
    llmDailyMessageCap: llmTrimmed && Number.isInteger(llmN) && llmN > 0 ? llmN : null,
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
    // A group renders one select; mixed per-domain levels resolve to the
    // widest so an edit never silently narrows what the server holds.
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
    connectors,
    usage: {
      storageValue,
      storageUnit,
      uploadMb: role.maxUploadSizeMb != null ? String(role.maxUploadSizeMb) : "",
      llmDaily: role.llmDailyMessageCap != null ? String(role.llmDailyMessageCap) : "",
    },
    cloud: role.cloudModelsAllowed,
    locks: role.mayOperateLocks,
  };
}
