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

/**
 * One PHYSICAL jack on the router — WARP-1866, the router's answer to the
 * switch's §7 `SwitchPort`. Derived by the routing service from
 * `network.device status` + board.json + uci; see services/routing/
 * router_ports.py for the derivation and the honesty rules behind it.
 */
export interface RouterPort {
  /** netdev name — "p1", "sfp", "eth0". The port's stable identity. */
  id: string;
  role: "wan" | "lan" | "guest" | "other" | "unused";
  /** uci interfaces whose traffic reaches this jack, in config order. A bridge
   *  member carries both `lan` and the `guest` VLAN riding the bridge. */
  networks: string[];
  /** netifd reports a device object for this jack. `false` = an empty SFP cage
   *  or a jack the running config never realised — absent, NOT down. */
  present: boolean;
  /** Admin state (`up`). `null` when absent. NEVER the link indicator — on a
   *  DSA port this is true for every jack, cable or not. */
  admin_up: boolean | null;
  /** The real link: netifd `carrier`. */
  link_up: boolean;
  /** "2.5 Gb" / "1 Gb" / "100 Mb". Null when there is no link. */
  speed: string | null;
  duplex: "full" | "half" | null;
  mac: string | null;
  is_sfp: boolean;
  traffic: { rx_bytes: number; tx_bytes: number } | null;
  /** online = carrier · offline = admin up, no cable · disabled = admin down ·
   *  absent = no reading at all. */
  status: "online" | "offline" | "disabled" | "absent";
}

/**
 * `GET /network/ports`. `supported: false` means this router shape reports no
 * physical port map (with `detail` saying so) — distinct from an unreachable
 * router, which surfaces as an error. Neither may render as an all-dark
 * faceplate.
 */
export interface RouterPortMap {
  supported: boolean;
  detail: string | null;
  model: string | null;
  ports: RouterPort[];
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

/**
 * droplet-ai ubus RPC access (read-only). The read/write scope chips are parsed
 * from the live on-box ACL (the routing service authenticates as droplet-ai).
 * Rotate-token / Revoke are deliberately absent — they need a coordinated
 * secret refresh that would self-lockout the Network tab, so the dashboard
 * renders them as honest-gated (disabled) controls, not real writes.
 */
export interface AiNetworkAccess {
  user: string;
  endpoint: string;
  readScopes: string[];
  writeScopes: string[];
  session: {
    active: boolean;
    expiresAt: number | null;
    rotates: string;
  };
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

/**
 * Where the household's Wi-Fi radios actually live.
 *
 * `NetworkOverview.wireless` is the ROUTER's own netifd wireless status and
 * nothing else, so on every shape where the router hosts no Wi-Fi it is `{}`.
 * That is the shipping fabric, not a fault: the RB5009 edge router has no
 * radio hardware at all and the household SSID is broadcast by the Droplet
 * access point (see ADR-005 / the "radios never live on the router" rule).
 * Summarising the router alone therefore reported "0 radios" for a network
 * that was broadcasting on two — which is what this rollup exists to fix.
 *
 * Counts only. The overview is readable by every authenticated principal,
 * unlike the owner/admin `GET /network/wifi/ap`, so no name or passphrase
 * crosses this boundary.
 */
export interface WirelessRadioSummary {
  /** Radios the router itself hosts. Zero on every edge-router shape. */
  router: number;
  /** Radios reported by ONLINE Droplet-image access points. */
  ap: number;
  /** `router + ap` — every radio we can account for. */
  total: number;
  /** Of `total`, how many are actually on the air. */
  active: number;
  /**
   * ONLINE APs that did NOT answer. Greater than zero means `total` is a
   * FLOOR, not a census — the honest "we can't see them right now" that a
   * plain zero would misreport as "there is no Wi-Fi".
   */
  apsNotReporting: number;
}

export interface NetworkOverview {
  interfaces: NetworkInterfaces;
  wireless: WirelessStatus;
  system: RouterSystemInfo;
  connectedDeviceCount: number;
  routerConnected: boolean;
  /**
   * Optional so an older orchestrator build (or a caller that constructs an
   * overview without an AP source) stays type-compatible; consumers must
   * handle its absence rather than assuming zero radios.
   */
  wirelessRadios?: WirelessRadioSummary;
}

export interface NetworkCommandResult {
  status: string;
  tier?: number;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  reason?: string;
}
