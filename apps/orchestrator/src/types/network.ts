// --- Network / Router types ---

export interface InterfaceStatus {
  up: boolean;
  pending: boolean;
  available: boolean;
  autostart: boolean;
  device: string;
  proto: string;
  uptime: number;
  l3_device: string;
  "ipv4-address": { address: string; mask: number }[];
  "ipv6-address": { address: string; mask: number }[];
  route: unknown[];
  "dns-server": string[];
  data: Record<string, unknown>;
}

export interface NetworkInterfaces {
  lan: InterfaceStatus;
  wan: InterfaceStatus;
}

export interface WirelessInterfaceConfig {
  mode: string;
  ssid: string;
  encryption: string;
}

export interface WirelessInterface {
  section: string;
  ifname: string;
  config: WirelessInterfaceConfig;
}

export interface WirelessRadio {
  up: boolean;
  pending: boolean;
  autostart: boolean;
  disabled: boolean;
  config: {
    hwmode: string;
    htmode: string;
    channel: number;
  };
  interfaces: WirelessInterface[];
}

export interface WirelessStatus {
  [radioName: string]: WirelessRadio;
}

export interface WirelessScanResult {
  ssid: string;
  bssid: string;
  channel: number;
  signal: number;
  quality: number;
  quality_max: number;
  encryption: {
    enabled: boolean;
    wpa?: number[];
    authentication?: string[];
  };
}

export interface WirelessClient {
  mac: string;
  signal: number;
  noise: number;
  rx_rate: number;
  tx_rate: number;
  connected_time: number;
}

export interface DhcpLease {
  expire: number;
  hostname: string;
  ipaddr: string;
  macaddr: string;
}

export interface FirewallZone {
  name: string;
  input: string;
  output: string;
  forward: string;
  network?: string;
  masq?: string;
}

export interface FirewallRule {
  name: string;
  src: string;
  dest?: string;
  src_mac?: string;
  proto?: string;
  dest_port?: string;
  target: string;
  enabled: string;
}

export interface PortForward {
  name: string;
  src: string;
  dest: string;
  proto: string;
  src_dport: string;
  dest_ip: string;
  dest_port: string;
  target: string;
  enabled: string;
}

export interface RouterBoardInfo {
  kernel: string;
  hostname: string;
  system: string;
  model: string;
  board_name: string;
  release: {
    distribution: string;
    version: string;
    target: string;
  };
}

export interface RouterResources {
  uptime: number;
  localtime: number;
  load: number[];
  memory: {
    total: number;
    free: number;
    shared: number;
    buffered: number;
  };
  swap: {
    total: number;
    free: number;
  };
}

export interface RouterSystemInfo {
  board: RouterBoardInfo;
  resources: RouterResources;
}

export interface NetworkSummary {
  system: RouterBoardInfo;
  resources: RouterResources;
  lan: InterfaceStatus;
  wan: InterfaceStatus;
  wireless: WirelessStatus;
  dhcp_leases: DhcpLease[];
  firewall_zones: Record<string, unknown>;
}

export interface ConnectedDevice {
  hostname: string;
  ipaddr: string;
  macaddr: string;
  expire: number;
  isWireless: boolean;
  signal?: number;
  rxRate?: number;
  txRate?: number;
}

export interface FirewallConfig {
  zones: Record<string, unknown>;
  rules: Record<string, unknown>;
  redirects: Record<string, unknown>;
}

export interface NetworkOverview {
  interfaces: NetworkInterfaces;
  wireless: WirelessStatus;
  system: RouterSystemInfo;
  connectedDeviceCount: number;
  routerConnected: boolean;
}

export interface NetworkCommandResult {
  status: string;
  tier?: number;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  reason?: string;
}
