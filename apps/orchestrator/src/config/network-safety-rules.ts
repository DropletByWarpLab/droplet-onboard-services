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
  // DHCP LAN pool reshape (start/limit/leasetime) — a LAN address-map change
  // that can strand connected clients if the pool is shrunk, so confirm it.
  "set_dhcp_pool",
  // Hostname change re-keys mDNS/.local + the dashboard status line; the active
  // session can briefly lose name resolution, so confirm it. (NTP toggle is
  // deliberately NOT here — it's Tier 1, low-risk + reversible, applies now.)
  "set_hostname",
  // UPnP/NAT-PMP automatic port opening — a firewall-class exposure change.
  "set_upnp",
  // WARP-1703 — band steering is an SSID-IDENTITY change, not a frequency
  // one, so it belongs beside set_wifi_password rather than set_channel.
  // The AP-side applier (droplet-edge-router `/etc/init.d/droplet-band-steer`)
  // sets `wireless.default_radio1.ssid` to the 2.4 GHz SSID when ON and to
  // `<ssid>-5g` when OFF. Flipping it therefore RENAMES the 5 GHz network:
  // every client associated on that band drops and has to be reconnected by
  // hand to a differently-named SSID — the same "re-auth every device" cost
  // that put create_guest_network here. And the orchestrator fans the write
  // across every ONLINE Droplet-image AP at once, so the blast radius is the
  // whole household, not one device.
  "set_ap_band_steering",
  // WARP-1712 — changing the ACCESS POINT's passphrase, mirroring
  // `set_wifi_password` on the router: the radios restart and every device on
  // the extender has to re-authenticate with the new secret, across every
  // ONLINE Droplet-image AP at once. Its sibling `set_ap_wifi_ssid` is
  // deliberately absent from this set: an SSID-only change matches the
  // router's Tier-1 `set_ssid` (same blast radius, same setup-wizard
  // contract). The route picks whichever operation the payload warrants, so a
  // save that carries a new password is always confirmed.
  "set_ap_wifi_password",
  "create_firewall_zone",
  "add_firewall_rule",
  // Rewriting a zone's default input/output/forward policy can sever the
  // management path — Tier-2 (confirm + 60s SDK auto-rollback).
  "set_zone_policy",
  "delete_firewall_rule",
  "add_forwarding",
  "interface_down",
  // KAN-10: interface add/edit. Rewriting /etc/config/network can cut the
  // dashboard's own connectivity (a wrong proto/address/zone on the management
  // interface), so confirm + 60s SDK auto-rollback. The management interface
  // itself is additionally refused/extra-confirmed at the routing layer.
  "create_interface",
  "edit_interface",
  // WARP-1907: enable/disable a PHYSICAL router jack. Same tier as the switch's
  // port writes, and for the same reason — one click takes whatever is plugged
  // into that jack off the network. The routing service adds a second, narrower
  // refusal on top (409 unless `force`) for the two jacks where the blast radius
  // is the household rather than one cable: the WAN, and a management jack with
  // a live link. Neither operation is in the MCP-admitted set; the routes are
  // owner/admin only, like create_interface.
  "router_port_enable",
  "router_port_disable",
  // Camera subnet
  "camera_subnet_setup",
  "camera_subnet_teardown",
  // Camera management
  "delete_camera",
  "disable_camera",
  // Sharing a clip mints a public "anyone with the link" signed URL to private
  // camera footage that stays unauthenticated for its whole TTL. Tier-2: the AI
  // must surface an approval chip before the orchestrator signs the URL.
  "share_clip",
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
  // KAN-8: router firmware flash + overlay wipe. Brick-risk, owner-only,
  // web-UI-only (never AI-triggerable) — same tier as factory_reset. The route
  // ALSO refuses these on any non-PRIMARY_ROUTER deployment shape before a token
  // is ever minted (the shipping single-box has no remote recovery from a wipe).
  "sysupgrade",
  "create_vpn_interface",
  "add_vpn_peer",
  "setup_vpn_firewall",
  // KAN-10: restart the whole networking stack — owner-only, web-UI-only,
  // confirm. A blunt instrument that briefly drops every interface (this
  // dashboard included), so it's never AI-triggerable.
  "restart_network",
  // droplet-ai RPC access management — reserved Tier-3 (web-UI-only, AI-blocked)
  // for the deferred real rotate/revoke. The routing service IS the droplet-ai
  // user, so any rotate/revoke that desyncs the credential self-locks-out the
  // whole Network tab (the WARP-868 failure class) — these must never be
  // AI-triggerable. No dispatcher case until the coordinated on-box secret
  // refresh exists; the dashboard renders them as honest-gated (disabled).
  "rotate_ai_token",
  "revoke_ai_access",
  // Switch — never let AI disable the port the appliance is on
  "switch_disable_protected_port",
]);

/**
 * Per-operation blast-radius copy surfaced in the Tier-2/3 confirm prompt
 * (KAN-10 AC4). When an operation has an entry here, `classifyNetworkCommand`
 * returns it as the `reason` so the dashboard's confirm dialog can show the
 * concrete consequence instead of the generic "requires confirmation" line.
 * Operations without an entry fall back to the generic reason.
 */
const BLAST_RADIUS_REASON: Record<string, string> = {
  create_interface:
    "Adding a network interface changes how the appliance connects. A wrong setting can disconnect devices — and could cut this dashboard's own connection.",
  edit_interface:
    "Editing a network interface can disconnect devices on it. If it's the interface this dashboard is on, you could lose your connection until it reverts.",
  restart_network:
    "Restarting networking briefly drops every interface and reconnects each device — this dashboard included — for a few seconds.",
  // WARP-1907. Two sentences, not one shared "port changed" line: turning a jack
  // on and cutting one off have opposite consequences, and a single reason would
  // have to be vague enough to cover both. The jack-specific warning (this is
  // your internet / this is the cable this dashboard arrives on) comes from the
  // routing service's `disable_guard`, which knows the deployment's management
  // interfaces; this is the generic Tier-2 line under it.
  router_port_disable:
    "Turning off a router port immediately disconnects whatever is plugged into it. If that cable feeds a switch or an access point, everything behind it drops too.",
  router_port_enable:
    "Turning a router port back on restores the connection to whatever is plugged into it.",
  set_ap_band_steering:
    "This renames your 5 GHz Wi-Fi network on every access point at once. Devices connected to it will drop and won't come back on their own — you'll need to reconnect each one to the new name.",
  set_ap_wifi_password:
    "This changes the Wi-Fi password on your access point. Every device connected to it will drop and won't come back on their own — you'll need to reconnect each one with the new password.",
};

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
      reason:
        BLAST_RADIUS_REASON[operation] ??
        `Operation '${operation}' is restricted to the web UI for safety`,
    };
  }

  // Tier 2: Requires confirmation
  if (TIER_2_OPERATIONS.has(operation)) {
    return {
      tier: 2 as SafetyTier,
      requiresConfirmation: true,
      reason:
        BLAST_RADIUS_REASON[operation] ??
        `Network operation '${operation}' requires confirmation`,
    };
  }

  // Tier 1: Auto-execute
  return {
    tier: 1 as SafetyTier,
    requiresConfirmation: false,
  };
}
