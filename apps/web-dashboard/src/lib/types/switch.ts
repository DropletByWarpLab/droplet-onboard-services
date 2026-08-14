/**
 * Managed-switch §7 contract types.
 *
 * Source of truth: reference/ADDON-network-switch-management.md §7 (frozen).
 * PR-B (dashboard) binds to these exactly; PR-A (backend) implements them.
 * Keep field names and unions identical to §7 — do not "improve" them here.
 */

/** `vlan_profile` — the two honest segmentation states (§6 camera-safe). */
export type SwitchVlanProfile = "flat-lan" | "segmented";

/** Per-port role; drives the row icon + label. `unknown` falls back to "Open". */
export type SwitchPortRole = "ap" | "camera" | "client" | "uplink" | "unknown";

/** Reuse of the §2.6 status-chip vocabulary. */
export type SwitchPortStatus = "online" | "warn" | "offline" | "blocked";

/** GET /api/switch/status */
export interface SwitchStatus {
  connected: boolean;
  model: string;
  firmware: string;
  auto_managed: boolean;
  vlan_profile: SwitchVlanProfile;
  last_provisioned_at: string | null;
  protected_port: number | null;
  poe_budget_w: number;
  poe_used_w: number;
  poe_ports_active: number;
}

/** Per-port PoE block. `null` on a port that can't deliver power (e.g. SFP). */
export interface SwitchPortPoe {
  delivering: boolean;
  power_w: number;
  class: number | null;
  max_power_w: number;
}

/**
 * Connected-device facts. Best-effort in v1 — the backend may omit `name`
 * (and the whole `device` block); the UI falls back to "Open" / the role.
 */
export interface SwitchPortDevice {
  mac: string;
  ip?: string | null;
  name?: string | null;
}

/**
 * Cumulative counters for a port, straight off the switch's netdev statistics.
 * WARP-1716: the evidence that a port is carrying traffic — without it the UI
 * could only reason about link state, so a busy port and an idle-but-plugged
 * port looked identical. `null` when the driver doesn't report counters.
 */
export interface SwitchPortTraffic {
  rx_bytes: number;
  tx_bytes: number;
}

/** One object per physical port — GET /api/switch/ports */
export interface SwitchPort {
  port: number;
  label: string;
  name?: string | null;
  role: SwitchPortRole;
  link_up: boolean;
  speed: string | null;
  is_sfp: boolean;
  vlan: number;
  vlan_name: string;
  poe: SwitchPortPoe | null;
  status: SwitchPortStatus;
  device?: SwitchPortDevice | null;
  traffic?: SwitchPortTraffic | null;
}

/** GET /api/switch/vlans */
export interface SwitchVlan {
  vlan_id: number;
  name: string;
  isolated: boolean;
  ports: number[];
}
