// --- Managed Switch types ---

export interface SwitchPortStatus {
  port: number;
  name: string;
  enabled: boolean;
  link_up: boolean;
  speed: string | null;
  duplex: string | null;
  is_sfp: boolean;
  vlan: number | null;
  poe: SwitchPoEPortStatus | null;
}

export interface SwitchPoEPortStatus {
  port: number;
  enabled: boolean;
  delivering: boolean;
  power_mw: number;
  class: string | null;
  max_power_mw: number;
}

export interface SwitchVlanInfo {
  vlan_id: number;
  name: string;
  ports: SwitchVlanPortMembership[];
}

export interface SwitchVlanPortMembership {
  port: number;
  tagged: boolean;
  member: boolean;
}

export interface SwitchSystemInfo {
  model: string;
  firmware_version: string;
  mac_address: string;
  uptime: string | null;
  hostname: string;
  port_count: number;
  poe_budget_mw: number | null;
  driver: string;
}

export interface WanDetectionResult {
  wan_port: number;
  confidence: string;
  reason: string;
  link_up: boolean;
}

export interface CameraSetupResult {
  status: string;
  vlan_id: number;
  camera_ports: number[];
  uplink_ports: number[];
  message: string;
}

// ===========================================================================
// §7 dashboard contract (ADDON-network-switch-management.md §7, ADR-018 item 12)
//
// These are the shapes the dashboard switch panel (PR-B) binds to. The
// orchestrator aggregation joins the switch-service raw reads (system-info +
// poe + provision-config + port-status + vlan_port_stat + vlan_membership)
// into these. They mirror the design handoff's static SWITCH_STATUS /
// buildPorts() reference shapes exactly.
// ===========================================================================

/** "flat-lan" → cameras share the LAN; "segmented" → cameras isolated on VLAN 100. */
export type SwitchVlanProfile = "flat-lan" | "segmented";

/** Port role drives the panel icon. */
export type SwitchPortRole = "ap" | "camera" | "client" | "uplink" | "unknown";

/** Port status chip. */
export type SwitchPortStatusChip = "online" | "warn" | "offline" | "blocked";

/** GET /api/switch/status */
export interface SwitchStatus {
  connected: boolean;
  model: string | null;
  firmware: string | null;
  auto_managed: boolean;
  vlan_profile: SwitchVlanProfile;
  last_provisioned_at: string | null;
  protected_port: number;
  poe_budget_w: number;
  poe_used_w: number;
  poe_ports_active: number;
  /**
   * True when the switch service rejected the orchestrator's read with a 403
   * auth failure (SERVICE_SECRET unset on the service, or a missing/wrong bearer
   * from the orchestrator) — DISTINCT from `connected:false`, which means the
   * switch hardware is genuinely absent. Lets the dashboard render a "Switch
   * auth not configured" banner instead of the calm "no managed switch" empty
   * state. Absent/false on the happy path and on a real absent switch.
   */
  auth_not_configured?: boolean;
}

/** Per-port PoE block on the §7 port shape (watts, not mW). */
export interface SwitchPortPoe {
  delivering: boolean;
  power_w: number;
  class: number | null;
  max_power_w: number;
}

/**
 * GET /api/switch/ports — one object per physical port.
 *
 * `name`/`device` are null in v1 (the friendly device name needs an
 * LLDP/MAC→device join — deferred; the panel falls back to "Open"/role).
 */
export interface SwitchPort {
  port: number;
  label: string;
  name: string | null;
  role: SwitchPortRole;
  link_up: boolean;
  speed: string | null;
  is_sfp: boolean;
  vlan: number | null;
  vlan_name: string | null;
  poe: SwitchPortPoe | null;
  status: SwitchPortStatusChip;
  device: SwitchPortDevice | null;
  /** WARP-1716: cumulative counters, or null when the driver reports none. */
  traffic: SwitchRawTraffic | null;
}

/** LLDP/MAC→device join target. Still null until the switch image exposes an
 *  FDB read (WARP-1717) — the port→MAC mapping has no ACL-legal source today. */
export interface SwitchPortDevice {
  mac: string;
  ip: string | null;
  name: string | null;
}

/** GET /api/switch/vlans */
export interface SwitchVlan {
  vlan_id: number;
  name: string;
  isolated: boolean;
  ports: number[];
}

// --- Raw switch-service read shapes (aggregation inputs) -------------------

/** GET {switch}/provision/config */
export interface SwitchProvisionConfig {
  vlan_profile: string;
  auto_managed: boolean;
  protected_port: number;
  camera_ports: number[];
  ap_ports: number[];
  client_ports: number[];
  poe_budget_w: number;
  last_provisioned_at: string | null;
}

/** GET {switch}/ports/status row. */
/**
 * Cumulative byte counters for a port. WARP-1716 — `null`/absent means the
 * driver reports no counters, which is NOT the same claim as "nothing has
 * crossed this port", so the two are never collapsed.
 */
export interface SwitchRawTraffic {
  rx_bytes: number;
  tx_bytes: number;
}

export interface SwitchRawPortStatus {
  port: number;
  link_up: boolean;
  speed: string;
  is_sfp: boolean;
  traffic?: SwitchRawTraffic | null;
}

/** GET {switch}/ports row (vlan_port_stat: PVID/tagging, not link). */
export interface SwitchRawPort {
  port: number;
  name: string;
  enabled: boolean;
  link_up: boolean;
  speed: string;
  duplex: string;
  is_sfp: boolean;
  is_trunk: boolean;
  vlan: number;
}

/** GET {switch}/poe row (mW). */
export interface SwitchRawPoe {
  port: number;
  enabled: boolean;
  delivering: boolean;
  power_mw: number;
  class: string;
  max_power_mw: number;
}
