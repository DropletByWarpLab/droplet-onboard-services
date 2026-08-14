/**
 * WARP-457 — workspace settings seeder + helpers.
 *
 * Canonical defaults for the dashboard's Settings surface. The seeder
 * runs on first boot (via scripts/setup.sh) and on every orchestrator
 * start (via app.ts) — both paths are idempotent because the seeder
 * uses `createMany({skipDuplicates: true})` so:
 *
 *   - First boot: every default lands.
 *   - Subsequent boots: existing rows untouched; `inserted` = 0.
 *   - Operator-edited values are NEVER overwritten — the seeder is
 *     insert-or-skip, not upsert. Mirrors the .env migrate_env posture
 *     in setup.sh (backfill, never clobber).
 *
 * Section + type are explicit Prisma enum members per the no-guessing
 * rule (CLAUDE.md). Adding a new default here doesn't require a schema
 * migration as long as `type` ∈ SettingType and `section` ∈
 * SettingSection — the column is Json so any shape passes through.
 *
 * The defaults below MIRROR the .env-derived defaults in src/config.ts
 * for the household-tunable surfaces; `.env` continues to own infra
 * knobs (DATABASE_URL, JWT_SECRET, OLLAMA_URL). Out of scope for this
 * ticket: switching the orchestrator from reading .env to reading the
 * settings table — that's a downstream wiring change tracked elsewhere.
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("workspace-settings");

/**
 * Public surface for one canonical default. The `section` and `type`
 * literals must match Prisma's `SettingSection` and `SettingType` enum
 * members exactly — the schema-regression test
 * (workspace-settings.schema.test.ts) locks the enum membership.
 */
export interface WorkspaceSettingDefault {
  key: string;
  section:
    | "workspace"
    | "memory_privacy"
    | "off_lan"
    | "hardware"
    | "appearance"
    | "ai";
  type:
    | "string"
    | "number"
    | "bool"
    | "duration_seconds"
    | "enum"
    | "json";
  value: unknown;
}

/**
 * The canonical default set. Order is the dashboard's rendering order;
 * adding a new default appends to the end of its section. Renaming a
 * key is a breaking change for the dashboard and requires a data
 * migration (the old key would become an orphan; no automatic
 * backfill).
 *
 * Values are illustrative defaults — operators tune from the
 * dashboard's Settings surface. The seeder never overwrites; once a
 * row exists the value is owned by the operator.
 */
export const WORKSPACE_SETTING_DEFAULTS: readonly WorkspaceSettingDefault[] = [
  // ── workspace ──
  // Display name + locale + the household-level default scope a new
  // file/document lands in. The default scope mirrors WARP-455's
  // Scope.team — household-wide.
  { key: "workspace.name", section: "workspace", type: "string", value: "Droplet Home" },
  { key: "workspace.locale", section: "workspace", type: "enum", value: "en-US" },
  { key: "workspace.default_scope", section: "workspace", type: "enum", value: "team" },

  // ── memory_privacy ──
  // Brain memory defaults — whether new memory items are pinned by
  // default, retention horizon, and whether the chat surface can
  // write to the brain without an explicit user gesture.
  { key: "memory_privacy.brain_enabled", section: "memory_privacy", type: "bool", value: true },
  { key: "memory_privacy.brain_default_pinned", section: "memory_privacy", type: "bool", value: false },
  { key: "memory_privacy.brain_retention_days", section: "memory_privacy", type: "number", value: 365 },
  { key: "memory_privacy.allow_chat_writes", section: "memory_privacy", type: "bool", value: true },

  // ── off_lan ──
  // Off-LAN posture — whether WireGuard peer minting is enabled and how
  // aggressively the orchestrator should renew peer keys. The box's public
  // address is no longer a stored setting: it comes from the per-device
  // droplet-us.com FQDN (ADR-023) resolved in vpn.ts, not a DDNS hostname
  // (WARP-974 removed the DuckDNS path end-to-end).
  { key: "off_lan.vpn_enabled", section: "off_lan", type: "bool", value: false },
  // Peer-renewal cadence; surfaces in the dashboard's VPN panel as a
  // configurable interval. Default 30 days (in seconds).
  { key: "off_lan.peer_renewal_interval", section: "off_lan", type: "duration_seconds", value: 2_592_000 },

  // ── hardware ──
  // Per-subsystem feature flags. These are user-facing on/off
  // switches; the actual driver decisions live in their respective
  // services. `camera_isolation` mirrors the CAMERA_SUBNET env knob's
  // intent (cameras live on a separate VLAN); `switch_supervision`
  // toggles the managed-switch driver's keepalive.
  { key: "hardware.cameras_enabled", section: "hardware", type: "bool", value: true },
  { key: "hardware.switch_supervision", section: "hardware", type: "bool", value: true },
  { key: "hardware.matter_enabled", section: "hardware", type: "bool", value: true },
  // WARP-475 (G3) seeded `hardware.camera_retention_days` (14) and
  // `hardware.event_retention_days` (null) here. WARP-1849 removed both.
  //
  // Their only reader was the nightly camera-retention purge, which
  // called Frigate endpoints that return 405 — so these rows described a
  // retention policy nothing enforced, while Frigate expired footage on
  // its own config. Two sources of truth, one of them fictional.
  //
  // Camera retention now lives solely in Frigate's config: per-camera via
  // `GET/PATCH /api/cameras/:name/settings`, appliance-wide via the
  // top-level `record:` block in docker/frigate/config.yml. Frigate
  // enforces both natively.

  // ── appearance ──
  // Dashboard theme, density, and the initial landing page. The
  // dashboard reads these to pick a CSS class set without an extra
  // network call after the initial /api/settings load.
  { key: "appearance.theme", section: "appearance", type: "enum", value: "system" },
  { key: "appearance.density", section: "appearance", type: "enum", value: "comfortable" },
  { key: "appearance.landing", section: "appearance", type: "enum", value: "home" },

  // ── ai ──
  // WARP-1112 — the active local model the box uses for chat. Changed
  // from the /models surface (PATCH /api/models/active), which validates
  // the tag is actually installed before writing. Empty string is the
  // explicit "unset" state (WARP-218 discipline: no meaning-by-absence) —
  // the orchestrator + dashboard then fall back to LLM_MODEL / the single
  // installed model. NOT editable via the generic /api/settings PATCH:
  // `ai` is intentionally absent from that route's SECTION_VALUES.
  { key: "ai.model.chat", section: "ai", type: "string", value: "" },
];

export interface SeedResult {
  /** Number of rows newly created on this call. 0 means everything was
   * already present — the expected steady-state outcome. */
  inserted: number;
}

/**
 * WARP-467 — canonical off-LAN channel defaults per FEATURES.md §8.
 * The sovereignty contract: software updates ON, cloud model escape
 * OFF, outbound email ON, telemetry ON, web fetch OFF. Operators
 * change individual rows via PATCH /api/settings/off-lan/:key; this
 * table is the first-boot bootstrap, not the runtime config.
 *
 * `key` literals must match the Prisma `OffLanChannelKey` enum. Adding
 * a new channel requires a schema migration (the enum is closed by
 * design) AND a new entry here.
 */
export interface OffLanChannelDefault {
  key:
    | "software_updates"
    | "cloud_model_escape"
    | "outbound_email"
    | "telemetry"
    | "web_fetch"
    | "ambient_data";
  enabled: boolean;
  requiresAdmin: boolean;
}

export const OFF_LAN_CHANNEL_DEFAULTS: readonly OffLanChannelDefault[] = [
  { key: "software_updates", enabled: true, requiresAdmin: true },
  { key: "cloud_model_escape", enabled: false, requiresAdmin: true },
  { key: "outbound_email", enabled: true, requiresAdmin: true },
  { key: "telemetry", enabled: true, requiresAdmin: true },
  { key: "web_fetch", enabled: false, requiresAdmin: true },
  // WARP-1436 — Weather & currency data (Open-Meteo, European Central
  // Bank). Gates GET /api/web/weather + /api/web/rates. OFF by default,
  // same sovereignty posture as web_fetch: the operator opts in.
  { key: "ambient_data", enabled: false, requiresAdmin: true },
];

/**
 * Insert the five canonical off-LAN channels if not already present.
 * Same insert-or-skip posture as seedWorkspaceSettings — operator
 * mutations from the dashboard are never clobbered on subsequent
 * boots. `lastChangedBy` / `lastChangedAt` start blank/now on first
 * insert (system seed, no actor).
 */
export async function seedOffLanChannels(
  prisma: PrismaClient,
): Promise<SeedResult> {
  const payload = OFF_LAN_CHANNEL_DEFAULTS.map((def) => ({
    key: def.key as any, // Prisma enum literal; cast for createMany input
    enabled: def.enabled,
    requiresAdmin: def.requiresAdmin,
  }));

  const result = await prisma.offLanAllowlistChannel.createMany({
    data: payload,
    skipDuplicates: true,
  });

  const inserted = result?.count ?? 0;
  if (inserted > 0) {
    logger.info(
      { inserted, total: OFF_LAN_CHANNEL_DEFAULTS.length },
      "off-LAN allowlist channels seeded",
    );
  } else {
    logger.debug(
      { total: OFF_LAN_CHANNEL_DEFAULTS.length },
      "off-LAN allowlist channels already seeded (no-op)",
    );
  }

  return { inserted };
}

/**
 * Insert every canonical default that isn't already present.
 *
 * Idempotent: backed by `createMany({skipDuplicates: true})`. The
 * underlying SQL is `INSERT … ON CONFLICT DO NOTHING` against the
 * `WorkspaceSetting_key_key` unique index, so a re-run can't surface
 * a uniqueness violation and can't mutate any existing row.
 *
 * Safe to call from multiple boot paths (setup.sh first-boot hook,
 * app.ts orchestrator start). The unique index makes concurrent
 * callers serialize at the DB without producing duplicate rows.
 */
export async function seedWorkspaceSettings(
  prisma: PrismaClient,
): Promise<SeedResult> {
  const payload = WORKSPACE_SETTING_DEFAULTS.map((def) => ({
    key: def.key,
    section: def.section as any, // Prisma enum literal; cast for createMany input
    type: def.type as any,
    valueJson: def.value as any,
  }));

  const result = await prisma.workspaceSetting.createMany({
    data: payload,
    skipDuplicates: true,
  });

  const inserted = result?.count ?? 0;
  if (inserted > 0) {
    logger.info(
      { inserted, total: WORKSPACE_SETTING_DEFAULTS.length },
      "workspace settings seeded",
    );
  } else {
    logger.debug(
      { total: WORKSPACE_SETTING_DEFAULTS.length },
      "workspace settings already seeded (no-op)",
    );
  }

  return { inserted };
}
