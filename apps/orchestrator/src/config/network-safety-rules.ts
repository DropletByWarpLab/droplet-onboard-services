/**
 * Network Safety Tier classification rules.
 *
 * Tier 1 (auto-execute): Read-only + low-risk writes (SSID, channel, DNS, static lease).
 * Tier 2 (requires confirmation): Firewall changes, WiFi password, WAN config, VLANs.
 * Tier 3 (blocked for AI, web UI only): Reboot, VPN, factory reset.
 *
 * Follows the same pattern as safety-rules.ts for smart home.
 */

import type { SafetyTier, TierClassification } from "./safety-rules.js";

/** Operations that always require confirmation. */
const TIER_2_OPERATIONS = new Set([
  // Router / firewall
  "block_device",
  "unblock_device",
  "add_port_forward",
  "remove_port_forward",
  "set_wifi_password",
  // No SSID entry on purpose: the /network/wifi/ssid route evaluates its
  // write as "set_ssid" — Tier 1, applies immediately, per the setup-wizard
  // contract (docs/SETUP_WIZARD_WALKTHROUGH.md, "Internet" step) and this
  // file's header. The AI-facing `set_wifi_ssid` tool enforces its own
  // confirmation in-handler (tools-core `confirmed` flag, the
  // memory_extract pattern) before the route applies the Tier-1 write.
  // Pinned by network-wifi-routes.test.ts.
  "set_wan_protocol",
  "set_lan_ip",
  "create_vlan",
  "create_guest_network",
  "create_firewall_zone",
  "add_firewall_rule",
  "delete_firewall_rule",
  "add_forwarding",
  "interface_down",
  // Camera subnet
  "camera_subnet_setup",
  "camera_subnet_teardown",
  // Camera management
  "delete_camera",
  "disable_camera",
  // Switch — port management
  "switch_port_enable",
  "switch_port_disable",
  // Switch — VLAN management
  "switch_create_vlan",
  "switch_delete_vlan",
  "switch_set_vlan_membership",
  // Switch — PoE
  "switch_poe_enable",
  "switch_poe_disable",
  // Switch — WAN detection
  "switch_wan_detect",
  // Switch — camera setup (bulk VLAN change)
  "switch_setup_cameras",
  // Switch — re-apply the managed provisioning layout (§7 POST /provision)
  "switch_provision",
]);

/** Operations blocked for AI — require manual web UI interaction. */
const TIER_3_OPERATIONS = new Set([
  "reboot",
  "factory_reset",
  "create_vpn_interface",
  "add_vpn_peer",
  "setup_vpn_firewall",
  "network_restart",
  // Switch — never let AI disable the port the Jetson is on
  "switch_disable_protected_port",
]);

/** Rate limit for network commands: max per entity per minute. */
export const NETWORK_RATE_LIMIT_PER_ENTITY = 5;
export const NETWORK_RATE_LIMIT_WINDOW_MS = 60_000;

/** Confirmation token expiry. */
export const NETWORK_CONFIRMATION_TOKEN_EXPIRY_MS = 60_000;

/**
 * Classify a network operation into a safety tier.
 */
export function classifyNetworkCommand(
  operation: string,
  _params?: Record<string, unknown>
): TierClassification {
  // Tier 3: Blocked for AI
  if (TIER_3_OPERATIONS.has(operation)) {
    return {
      tier: 3 as SafetyTier,
      requiresConfirmation: true,
      reason: `Operation '${operation}' is restricted to the web UI for safety`,
    };
  }

  // Tier 2: Requires confirmation
  if (TIER_2_OPERATIONS.has(operation)) {
    return {
      tier: 2 as SafetyTier,
      requiresConfirmation: true,
      reason: `Network operation '${operation}' requires confirmation`,
    };
  }

  // Tier 1: Auto-execute
  return {
    tier: 1 as SafetyTier,
    requiresConfirmation: false,
  };
}
