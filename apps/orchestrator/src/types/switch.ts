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
