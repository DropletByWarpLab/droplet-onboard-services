/**
 * Smart Home Safety Tier classification rules.
 *
 * Tier 1 (auto-execute): Low-risk domains — lights, switches, media, sensors.
 * Tier 2 (requires confirmation): High-risk domains — locks, alarms, garage doors, extreme temps.
 * Tier 3 (audit-only): All commands are logged regardless of tier.
 *
 * Based on design doc Section 13.2: Three-tier safety framework.
 */

export type SafetyTier = 1 | 2 | 3;

export interface TierClassification {
  tier: SafetyTier;
  requiresConfirmation: boolean;
  reason?: string;
  /**
   * WARP-353 (ADR-014 ②): true when the action is Tier-3 in the "blocked
   * for AI" sense — the evaluator refuses it outright (no confirmation
   * path). Used by the client-tool catalog below; absent for the smart-home
   * domains, where Tier 3 means "audit-only" per the original framework.
   */
  blockedForAi?: boolean;
}

/** Domains that always require user confirmation before execution. */
const TIER_2_DOMAINS = new Set([
  "lock",
  "alarm_control_panel",
]);

/** Domain + service combinations that escalate to Tier 2. */
const TIER_2_OVERRIDES: Array<{
  domain: string;
  service?: string;
  condition?: (data?: Record<string, unknown>) => boolean;
  reason: string;
}> = [
  {
    domain: "cover",
    service: "close_cover",
    reason: "Closing covers (e.g., garage doors) can pose safety risks",
  },
  {
    domain: "cover",
    service: "open_cover",
    reason: "Opening covers (e.g., garage doors) requires confirmation for security",
  },
  {
    domain: "climate",
    service: "set_temperature",
    condition: (data) => {
      const temp = data?.temperature as number | undefined;
      return temp !== undefined && temp >= 30;
    },
    reason: "Temperature >= 30C may be unsafe",
  },
  {
    // KAN-7: turning a thermostat OFF can leave a home with no heating or
    // cooling, so it requires confirmation. Switching between
    // heat/cool/auto stays Tier-1 (direct).
    domain: "climate",
    service: "set_mode",
    condition: (data) => (data?.mode as string | undefined) === "off",
    reason: "Turning off climate control can leave the home with no heating or cooling",
  },
];

// ── WARP-353: client-dispatched tool tiers (ADR-014 ①/②) ──
// The V1 desktop tool-host catalog is a CLOSED whitelist: anything not
// listed is blocked and requires an ADR amendment. `get_clipboard` and
// `screenshot` are explicitly Tier-3 (blocked for AI) until the deep-assist
// ADR (WARP-549) is Accepted — do not move them without that sign-off.

/** Domain prefix for client-dispatched tool entityIds (`client_tool.<tool>`). */
export const CLIENT_TOOL_DOMAIN = "client_tool";

/** ADR-014 ①: Tier-1 client tools — auto-execute (still rate-limited + audited). */
const CLIENT_TIER_1_TOOLS = new Set([
  "notify",
  "open_url",
  "reveal_in_finder",
  "reveal_in_explorer",
  "get_focused_app",
  "list_recent_files",
]);

/** ADR-014 ①: Tier-2 client tools — per-call native confirm on the target device. */
const CLIENT_TIER_2_TOOLS = new Set([
  "open_file",
  "paste_text",
  "download_to_path",
  "show_overlay",
]);

/** Parameter bounds for Tier 1 validation. */
export const PARAMETER_BOUNDS: Record<string, { min: number; max: number; field: string }> = {
  "climate.set_temperature": { field: "temperature", min: 10, max: 35 },
  "light.turn_on": { field: "brightness", min: 0, max: 255 },
  "cover.set_cover_position": { field: "position", min: 0, max: 100 },
  "fan.set_percentage": { field: "percentage", min: 0, max: 100 },
  "media_player.set_volume_level": { field: "volume_level", min: 0, max: 1 },
};

/** Rate limit: max commands per entity per minute. */
export const RATE_LIMIT_PER_ENTITY = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Confirmation token expiry in milliseconds. */
export const CONFIRMATION_TOKEN_EXPIRY_MS = 60_000;

/**
 * Classify a smart home command into a safety tier.
 */
export function classifyCommand(
  domain: string,
  service: string,
  data?: Record<string, unknown>
): TierClassification {
  // WARP-353: client-dispatched tools (ADR-014 ①/②) — closed V1 whitelist.
  if (domain === CLIENT_TOOL_DOMAIN) {
    if (CLIENT_TIER_1_TOOLS.has(service)) {
      return { tier: 1, requiresConfirmation: false };
    }
    if (CLIENT_TIER_2_TOOLS.has(service)) {
      return {
        tier: 2,
        requiresConfirmation: true,
        reason: `'${service}' acts on the target device and requires per-call confirmation`,
      };
    }
    return {
      tier: 3,
      requiresConfirmation: false,
      blockedForAi: true,
      reason: `Client tool '${service}' is not in the V1 catalog (ADR-014 — blocked for AI)`,
    };
  }

  // Tier 2: Always-confirm domains
  if (TIER_2_DOMAINS.has(domain)) {
    return {
      tier: 2,
      requiresConfirmation: true,
      reason: `Commands to ${domain} devices require confirmation`,
    };
  }

  // Tier 2: Conditional overrides
  for (const override of TIER_2_OVERRIDES) {
    if (override.domain !== domain) continue;
    if (override.service && override.service !== service) continue;
    if (override.condition && !override.condition(data)) continue;

    return {
      tier: 2,
      requiresConfirmation: true,
      reason: override.reason,
    };
  }

  // Tier 1: Auto-execute with bounds checking
  return {
    tier: 1,
    requiresConfirmation: false,
  };
}
