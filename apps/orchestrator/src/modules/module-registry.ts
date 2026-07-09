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
    toolDomains: ["knowledge"], core: false, defaultEnabled: true,
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
    toolDomains: ["calendar"], core: false, defaultEnabled: true,
    available: () => true, // native to the orchestrator
  },
  {
    id: "projects", label: "Projects",
    description: "Lightweight project / task tracking.",
    category: "workspace", routePrefixes: ["/api/pm/projects"], navHrefs: ["/projects"],
    toolDomains: ["projects"], core: false, defaultEnabled: false,
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
    toolDomains: ["matter", "devices"], core: false, defaultEnabled: false,
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

// ── Business-type presets ────────────────────────────────────────────────────

export interface BusinessTypeDef {
  id: BusinessType;
  label: string;
  description: string;
  /** Non-core modules ON for this preset (core modules are always on). `custom`
   *  has an empty set and is applied as a no-op (leaves current toggles as-is). */
  modules: ModuleId[];
}

export const BUSINESS_TYPES: readonly BusinessTypeDef[] = [
  {
    id: "home", label: "Home",
    description: "A household — assistant, files, calendar, smart home, cameras.",
    modules: ["knowledge", "files", "calendar", "voice", "cameras", "smart_home", "network"],
  },
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
