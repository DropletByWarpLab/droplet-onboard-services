/**
 * Module registry — the ONE canonical catalog of user-facing capability modules
 * (the same "single registry" discipline as packages/tools-core). Design spec:
 * docs/superpowers/specs/2026-07-07-module-toggles-design.md.
 *
 * Two orthogonal axes (never conflated):
 *   - AVAILABILITY: is the module's backend deployed on this box? Derived from
 *     the EXISTING deploy-time config signals (service URL / env flag / token).
 *     Deploy-time; not user-controllable.
 *   - ENABLEMENT: has the operator turned the module ON? Stored in ModuleSetting
 *     (runtime, UI-driven). Missing row → this registry's `defaultEnabled`.
 * A module is EFFECTIVE iff `available && enabled`. You can't enable an
 * unavailable module. This keeps the runtime layer from fighting COMPOSE_PROFILES.
 */
import type { ModuleId, BusinessType } from "@prisma/client";

/** The subset of `config` the availability checks read. Kept structural so this
 *  module doesn't depend on the full Config type. */
export interface AvailabilityConfig {
  AI_GATEWAY_URL: string;
  FILE_INDEXER_URL: string;
  NEXTCLOUD_URL: string;
  DOCS_ENABLED: unknown; // string "1"/"true"/… or boolean — normalized by isTruthy
  DOCS_INTERNAL_URL: string;
  SERVICE_TOKEN_EMAIL: string;
  SERVICE_TOKEN_VOICE: string;
  FRIGATE_URL: string;
  DROPLET_MATTER_SERVICE_URL: string;
  ROUTING_SERVICE_URL: string;
  SWITCH_SERVICE_URL: string;
}

const isSet = (v: string | undefined | null): boolean => !!(v && v.trim().length > 0);
const isTruthy = (v: unknown): boolean =>
  v === true || (typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));

export interface ModuleDef {
  id: ModuleId;
  label: string;
  description: string;
  category: "workspace" | "operations";
  /** `/api/*` prefixes requireModuleEnabled() guards when this module is off. */
  routePrefixes: string[];
  /** Dashboard routes the nav hides when this module is off (for the design MD). */
  navHrefs: string[];
  /** tools-core handler domains dropped from the agent when this module is off. */
  toolDomains: string[];
  /** Core modules are always effective when available and are never toggleable
   *  (a Droplet with no assistant isn't a Droplet). */
  core: boolean;
  /**
   * WARP-1585 — an explicit parent module this one cannot function without.
   *
   * A DEPENDENCY, not a grouping: the child is never effective (workspace
   * axis) and never resolves onto a person (§9 axis) unless the parent is.
   * Declared here, in the one registry, so both axes and the dashboard read
   * the SAME edge instead of the coupling falling out of an Express prefix
   * collision — which is what `docs` had, silently, and `knowledge` had
   * wrongly. See `satisfiedModuleIds`.
   *
   * The bar for adding one: the child has no reachable surface of its own
   * without the parent. It is not for "these feel related".
   */
  requires?: ModuleId;
  /** Fallback enablement when there's no ModuleSetting row and no preset applied. */
  defaultEnabled: boolean;
  /** Availability signal, reusing the existing deploy-time config reads. NOTE:
   *  modules gated only by a URL with a non-empty default (files/cameras/network/
   *  switch/knowledge) read as always-available in v1 — a health-probe refinement
   *  is future work; ENABLEMENT is the real operator gate. Modules with an
   *  empty-default token/flag (docs/email/voice/smart_home) get a true signal. */
  available: (cfg: AvailabilityConfig) => boolean;
}

/** Ordered so the settings UI can render the catalog top-to-bottom. */
export const MODULES: readonly ModuleDef[] = [
  {
    id: "chat", label: "Ask AI",
    description: "The local AI assistant — chat, tools, and agent actions.",
    category: "workspace", routePrefixes: ["/api/llm"], navHrefs: ["/chat"],
    toolDomains: [], core: true, defaultEnabled: true,
    available: (c) => isSet(c.AI_GATEWAY_URL),
  },
  {
    id: "knowledge", label: "Knowledge",
    description: "Retrieval over your indexed files and notes (RAG).",
    category: "workspace", routePrefixes: ["/api/files/knowledge"], navHrefs: ["/knowledge"],
    // WARP-1527: "knowledge" is not a tools-core ToolDomain — the module's
    // agent surface is the memory suite (memory_recall & co.).
    toolDomains: ["memory"], core: false, defaultEnabled: true,
    // WARP-1585: deliberately NO `requires`. The prefix nests under `/api/files`
    // for a naming reason recorded in files-knowledge.ts (`/files/recents` and
    // `/files/search` were already taken by Nextcloud routes), NOT a data one:
    // these routes read FileContentChunk rows out of the orchestrator's own
    // Postgres, spanning BOTH the `nextcloud` and `brain` sources, behind the
    // file-indexer. Nothing on the path touches Nextcloud, and the module has
    // its own page at /knowledge. It stands alone.
    available: (c) => isSet(c.FILE_INDEXER_URL),
  },
  {
    id: "files", label: "Files",
    description: "Nextcloud-backed file storage, sharing, and search.",
    category: "workspace", routePrefixes: ["/api/files"], navHrefs: ["/files"],
    toolDomains: ["files"], core: false, defaultEnabled: true,
    available: (c) => isSet(c.NEXTCLOUD_URL),
  },
  {
    id: "docs", label: "Documents",
    description: "In-browser document editing / co-authoring (OnlyOffice).",
    category: "workspace", routePrefixes: ["/api/files/docs"], navHrefs: [],
    toolDomains: [], core: false, defaultEnabled: false,
    // WARP-1585: Documents genuinely depends on Files, and now says so.
    // Note `navHrefs: []` — Documents has no surface of its own. Its one
    // prefix serves the doc-engine health probe; the substantive act is
    // minting an editor session, which lives on
    // `/api/files/:filePath(*)/editor-session` — a Nextcloud path, correctly
    // gated by `files` — and its only entry point is the Files preview pane.
    // A Documents grant with no Files grant therefore grants nothing
    // reachable. Before this the coupling was real but accidental (the
    // `/api/files` prefix mount happened to swallow `/api/files/docs`); it is
    // now declared, so the UI can show it as blocked WITH A REASON instead of
    // presenting a toggle that quietly does nothing.
    requires: "files",
    available: (c) => isTruthy(c.DOCS_ENABLED) && isSet(c.DOCS_INTERNAL_URL),
  },
  {
    id: "email", label: "Email",
    description: "Inbox triage and email search over the operator's mailbox.",
    category: "workspace", routePrefixes: ["/api/email"], navHrefs: ["/email"],
    toolDomains: ["email"], core: false, defaultEnabled: false,
    available: (c) => isSet(c.SERVICE_TOKEN_EMAIL),
  },
  {
    id: "calendar", label: "Calendar",
    description: "Scheduling and events.",
    category: "workspace", routePrefixes: ["/api/calendar"], navHrefs: ["/calendar"],
    // WARP-1527: reminders + notifications ride the calendar module (the
    // WARP-1532 grouping) — turning Calendar off drops all three suites.
    toolDomains: ["calendar", "reminders", "notifications"], core: false, defaultEnabled: true,
    available: () => true, // native to the orchestrator
  },
  {
    id: "projects", label: "Projects",
    description: "Lightweight project / task tracking.",
    category: "workspace", routePrefixes: ["/api/pm/projects"], navHrefs: ["/projects"],
    // WARP-1527: the tools-core domain for the PM suite is "pm".
    toolDomains: ["pm"], core: false, defaultEnabled: false,
    available: () => true, // native to the orchestrator
  },
  {
    id: "voice", label: "Voice",
    description: "Hands-free voice assistant (speech in / speech out).",
    category: "operations", routePrefixes: ["/api/voice", "/api/stt"], navHrefs: ["/voice"],
    toolDomains: [], core: false, defaultEnabled: false,
    available: (c) => isSet(c.SERVICE_TOKEN_VOICE),
  },
  {
    id: "cameras", label: "Cameras",
    description: "Camera streams, events, and object detection (Frigate).",
    category: "operations", routePrefixes: ["/api/cameras"], navHrefs: ["/cameras", "/events"],
    toolDomains: ["cameras"], core: false, defaultEnabled: false,
    available: (c) => isSet(c.FRIGATE_URL),
  },
  {
    id: "smart_home", label: "Devices",
    description: "Smart-home devices over Matter.",
    // Gate ONLY the Matter/smart-home surface. "/api/devices" is deliberately
    // NOT gated here: it hosts the appliance/fleet device registry, device
    // pairing (/api/devices/pair*), push-notification subscribe
    // (/api/devices/push/*), and network device-clients (/api/devices/clients*)
    // — none of which are smart-home. Toggling this module off must never 404
    // pairing or push app-wide. Matter devices live under /api/matter/devices.
    category: "operations", routePrefixes: ["/api/matter"], navHrefs: ["/devices"],
    // WARP-1527: the tools-core domain is "smart-home" ("matter"/"devices"
    // were never catalog values, so the module-off drop was a silent no-op).
    toolDomains: ["smart-home"], core: false, defaultEnabled: false,
    available: (c) => isSet(c.DROPLET_MATTER_SERVICE_URL),
  },
  {
    id: "network", label: "Network",
    description: "Router supervision, Wi-Fi, and remote access (VPN).",
    category: "operations", routePrefixes: ["/api/network", "/api/vpn"], navHrefs: ["/network", "/remote-access"],
    toolDomains: ["network"], core: false, defaultEnabled: true,
    available: (c) => isSet(c.ROUTING_SERVICE_URL),
  },
  {
    id: "managed_switch", label: "Managed switch",
    description: "Managed network switch (VLANs, PoE, port control).",
    category: "operations", routePrefixes: ["/api/switch"], navHrefs: [],
    toolDomains: ["switch"], core: false, defaultEnabled: false,
    available: (c) => isSet(c.SWITCH_SERVICE_URL),
  },
] as const;

export const MODULE_BY_ID: ReadonlyMap<ModuleId, ModuleDef> = new Map(
  MODULES.map((m) => [m.id, m])
);

export function getModuleDef(id: ModuleId): ModuleDef | undefined {
  return MODULE_BY_ID.get(id);
}

/** Runtime membership test for the Prisma enum (route param validation). */
export function isModuleId(v: string): v is ModuleId {
  return MODULE_BY_ID.has(v as ModuleId);
}

// ── WARP-1585: nested route prefixes ─────────────────────────────────────────
//
// Express `app.use(prefix, handler)` is a PREFIX mount that matches on a
// SEGMENT BOUNDARY: `/api/files` matches `/api/files`, `/api/files/` and
// `/api/files/anything`, but not `/api/filesomething`. Three of this catalog's
// prefixes nest — `/api/files/knowledge` and `/api/files/docs` both sit inside
// `/api/files` — so a gate registered for `files` silently also guards the two
// sibling modules' namespaces. That is the WARP-1585 bug: three toggles in the
// UI, one wire behind them, and the wire attached to the wrong switch.
//
// The fix is not to rename the prefixes (they are a published API surface and
// files-knowledge.ts records why the namespace is what it is). It is to SCOPE
// each module's gate to its own namespace, deriving the exclusions from this
// registry so there is no parallel list to drift.

/**
 * Does `path` fall under `prefix` by Express's `app.use` rules? Matches on a
 * segment boundary only, so `/api/filesknowledge` is NOT under `/api/files`.
 *
 * Compares raw (percent-encoded) pathnames, exactly like Express's own layer
 * matching. A request that encodes its way past this comparison also fails to
 * match the sibling router's literal path, so it 404s on the router instead —
 * and it keeps the OUTER module's gate, which is the fail-closed direction.
 */
export function pathIsUnder(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.length === 0 || rest.startsWith("/");
}

/**
 * Prefixes owned by OTHER modules that sit strictly inside `prefix` — the set
 * a gate mounted at `prefix` for `moduleId` must NOT fire on. Sorted for a
 * stable, assertable order.
 *
 * Only FOREIGN nesting counts. A module nesting its own prefixes inside each
 * other is harmless: the same gate would run either way.
 */
export function foreignSubPrefixes(moduleId: ModuleId, prefix: string): string[] {
  const out: string[] = [];
  for (const def of MODULES) {
    if (def.id === moduleId) continue;
    for (const p of def.routePrefixes) {
      if (p.startsWith(`${prefix}/`)) out.push(p);
    }
  }
  return out.sort();
}

// ── WARP-1585: declared module dependencies ──────────────────────────────────

/** child → parent, from the `requires` declarations above. */
export const MODULE_REQUIRES: ReadonlyMap<ModuleId, ModuleId> = new Map(
  MODULES.flatMap((def) => (def.requires ? [[def.id, def.requires] as const] : [])),
);

/**
 * Narrow `held` to the modules whose declared parents are also held.
 *
 * Runs to a FIXED POINT, so a grandchild falls when the grandparent does
 * whatever order the edges are declared in. Today's catalog has a single edge
 * (docs → files); the closure does not depend on that staying true.
 *
 * Applied at BOTH axes the dependency governs, from this one definition:
 *   - the WORKSPACE axis (modules.service `computeEffectiveIds` /
 *     `computeModuleStates`) — "is Documents on for this box";
 *   - the PER-PERSON §9 axis (effective-access.service, right after the
 *     workspace intersection) — "does this person hold Documents".
 * They are genuinely independent narrowings — a box can have Files on while a
 * person does not hold it — so each has to apply the rule; what must not
 * happen, and is what this function exists to prevent, is each deriving the
 * rule for itself.
 *
 * @param edges injectable for testing dependency CHAINS the live catalog does
 *              not yet contain — the same seam idiom as `requireFeatureAccess`'s
 *              `resolve` parameter.
 */
export function satisfiedModuleIds(
  held: ReadonlySet<ModuleId>,
  edges: ReadonlyMap<ModuleId, ModuleId> = MODULE_REQUIRES,
): Set<ModuleId> {
  const out = new Set(held);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of out) {
      const parent = edges.get(id);
      if (parent !== undefined && !out.has(parent)) {
        out.delete(id);
        changed = true;
      }
    }
  }
  return out;
}

// ── Business-type presets ────────────────────────────────────────────────────

export interface BusinessTypeDef {
  id: BusinessType;
  label: string;
  description: string;
  /** Non-core modules ON for this preset (core modules are always on). `custom`
   *  has an empty set and is applied as a no-op (leaves current toggles as-is). */
  modules: ModuleId[];
}

// WARP-1341: business-only build — the former "Home" preset is not offered
// (Prisma's `BusinessType.home` enum value survives for old rows; the data
// migration re-points those to `custom`, which preserves their toggles).
export const BUSINESS_TYPES: readonly BusinessTypeDef[] = [
  {
    id: "professional_office", label: "Professional office",
    description: "An office — documents, email, projects, scheduling.",
    modules: ["knowledge", "files", "docs", "email", "calendar", "projects", "network"],
  },
  {
    id: "retail", label: "Retail",
    description: "A store — cameras, smart devices, network, managed switch.",
    modules: ["knowledge", "files", "calendar", "cameras", "smart_home", "network", "managed_switch"],
  },
  {
    id: "clinic", label: "Clinic / practice",
    description: "A practice — documents, scheduling, projects, cameras.",
    modules: ["knowledge", "files", "docs", "calendar", "projects", "cameras", "network"],
  },
  {
    id: "hospitality", label: "Hospitality",
    description: "A hotel / venue — rooms, devices, voice, cameras.",
    modules: ["knowledge", "files", "calendar", "voice", "cameras", "smart_home", "network", "managed_switch"],
  },
  {
    id: "custom", label: "Custom",
    description: "Start from what's on now and toggle modules yourself.",
    modules: [],
  },
] as const;

export const BUSINESS_TYPE_BY_ID: ReadonlyMap<BusinessType, BusinessTypeDef> = new Map(
  BUSINESS_TYPES.map((b) => [b.id, b])
);

export function isBusinessType(v: string): v is BusinessType {
  return BUSINESS_TYPE_BY_ID.has(v as BusinessType);
}
