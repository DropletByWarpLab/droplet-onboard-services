// --- Network / Router types ---

export interface InterfaceStatus {
  up: boolean;
  /** Whether this interface is configured on this box. `false` = absent on this
   *  hardware shape (e.g. no `wan` on a single-box), distinct from a configured
   *  interface that is currently down (`present: true, up: false`). Canonical
   *  presence signal — do not infer absence from missing/empty fields. */
  present?: boolean;
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

/**
 * One row of the full interface enumeration (GET /network/interfaces/all).
 * Distinct from NetworkInterfaces (the lan/wan overview): this enumerates every
 * configured interface incl. VLANs + WireGuard. `present:false` means the
 * section is configured but has no live ubus object on this box (render as an
 * honest "not on this box" row, never a fake "down"). `zone`/`address` are null
 * when not joinable/reported, never fabricated.
 */
export interface NetworkInterfaceRow {
  name: string;
  device: string | null;
  proto: string | null;
  address: string | null;
  zone: string | null;
  up: boolean;
  present: boolean;
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

/**
 * Read-only host-radio detail from iwinfo (single-box: one combined hostapd
 * radio). Every field is nullable — on the single-box the live UCI/wireless
 * source is empty and iwinfo may not report every field, so the UI shows "not
 * reported" rather than a fabricated value. `supported:false` + `hostRadio:true`
 * is the honesty envelope for the single combined-radio shape (it can't be
 * turned off independently); `broadcasting` is derived from the real iwinfo
 * mode, never hardcoded.
 */
export interface RadioDetail {
  supported: boolean;
  hostRadio: boolean;
  broadcasting: boolean;
  channel: number | null;
  htmode: string | null;
  txpower: number | null;
  country: string | null;
  mode: string | null;
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

// WARP-42: firewall payload shape mirrors the routing service's Pydantic
// models (services/routing/schemas.py). Every field is optional because
// OpenWrt may omit defaults; `[key: string]` allows unknown future keys to
// flow through without breaking the dashboard. `network` and `proto` are
// unions because UCI stores them as either a string or a list on disk.

export interface FirewallZone {
  name?: string;
  network?: string | string[];
  input?: string;
  output?: string;
  forward?: string;
  masq?: string;
  [key: string]: unknown;
}

export interface FirewallRule {
  name?: string;
  src?: string;
  dest?: string;
  src_mac?: string;
  proto?: string | string[];
  src_port?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

/** Port-forward / NAT redirect rule. Renamed historically from `PortForward`. */
export interface FirewallRedirect {
  name?: string;
  src?: string;
  dest?: string;
  proto?: string | string[];
  src_dport?: string;
  dest_ip?: string;
  dest_port?: string;
  target?: string;
  enabled?: string;
  [key: string]: unknown;
}

/** Back-compat alias — older callers referenced `PortForward`. */
export type PortForward = FirewallRedirect;

/** Wire shape of the `GET /firewall/{zones,rules,redirects}` endpoints. */
export interface FirewallCollection<T> {
  values: Record<string, T>;
}

export type FirewallZones = FirewallCollection<FirewallZone>;
export type FirewallRules = FirewallCollection<FirewallRule>;
export type FirewallRedirects = FirewallCollection<FirewallRedirect>;

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

/**
 * Editable system controls + honest gates for the deployment shape.
 *
 * `hostname` + `ntp` are real, editable controls on the in-container OpenWrt.
 * `statusLed` + `country` carry a `supported` / `editable` flag so the UI can
 * render an honest "not available on this appliance" state where the single-box
 * shape can't really drive them (no system.led ubus surface; host-hostapd
 * country is pinned) — same posture as the guest-wifi/UPnP gates. The flags are
 * authoritative from the orchestrator's DROPLET_AP_MODE, not the box read.
 */
export interface SystemControls {
  hostname: string | null;
  ntpEnabled: boolean;
  statusLed: { supported: boolean; enabled: boolean };
  country: { value: string | null; editable: boolean };
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
  zones: FirewallZones;
  rules: FirewallRules;
  redirects: FirewallRedirects;
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
