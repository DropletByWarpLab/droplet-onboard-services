/**
 * §7 switch aggregation (ADDON-network-switch-management.md §7, ADR-018 item 12).
 *
 * The orchestrator owns the join from the switch-service raw reads into the
 * dashboard §7 contract. Keeping the join here (not in the driver/service)
 * keeps the driver seam clean — the service exposes raw reads; the orchestrator
 * owns the product-facing shape, RBAC, Tier-2 and Activity.
 *
 * Inputs (all from the switch service, mocked at the .client boundary in tests):
 *   - system-info        : model / firmware
 *   - /health connected  : live-switch reachability
 *   - poe (mW)           : per-port delivering / power / class / max
 *   - port_status        : link_up / speed (the REAL link source)
 *   - ports              : vlan_port_stat — PVID + admin-enabled + is_sfp
 *   - vlans              : membership (vlan_name, which ports)
 *   - provision-config   : profile / protected_port / role ports / budget /
 *                          auto_managed / last_provisioned_at
 *
 * The derivation functions are pure (no I/O) so role/status/profile/mW→W are
 * directly unit-testable; the `fetch*` orchestration functions below call the
 * client and apply them.
 */

import * as switchClient from "./switch.client.js";
import { SwitchAuthError } from "../types/switch-error.js";
import type {
  SwitchStatus,
  SwitchPort,
  SwitchVlan,
  SwitchPortRole,
  SwitchPortStatusChip,
  SwitchPortPoe,
  SwitchVlanProfile,
  SwitchProvisionConfig,
  SwitchRawPort,
  SwitchRawPortStatus,
  SwitchRawPoe,
  SwitchRawTraffic,
} from "../types/switch.js";

/** Membership row from the switch service's per-VLAN shape. */
interface RawVlanMembershipPort {
  port: number;
  tagged: boolean;
  member: boolean;
}
interface RawVlan {
  vlan_id: number;
  name: string;
  ports: RawVlanMembershipPort[];
}

/** Raw system-info from the switch service (subset the §7 status needs). */
interface RawSystemInfo {
  model?: string | null;
  firmware_version?: string | null;
}

const CAMERA_VLAN = 100;

/** mW → W, rounded to 0.1 W (the §7 contract reports one decimal). */
export function mwToW(mw: number): number {
  if (!Number.isFinite(mw) || mw <= 0) return 0;
  return Math.round(mw / 100) / 10;
}

/**
 * Parse a PoE class label to its integer class, or null.
 * The firmware reports "Class 3" / "Class 4" / "" — we surface the int (3/4)
 * the §7 contract uses, never fabricating a class when none was negotiated.
 */
export function parsePoeClass(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Coerce the service's profile string to the §7 union; unknown → flat-lan. */
export function normalizeVlanProfile(profile: string | null | undefined): SwitchVlanProfile {
  return profile === "segmented" ? "segmented" : "flat-lan";
}

/** Role from the provision-config port assignments. protected_port → uplink. */
export function derivePortRole(port: number, config: SwitchProvisionConfig): SwitchPortRole {
  if (config.protected_port > 0 && port === config.protected_port) return "uplink";
  if (config.camera_ports.includes(port)) return "camera";
  if (config.ap_ports.includes(port)) return "ap";
  if (config.client_ports.includes(port)) return "client";
  return "unknown";
}

/**
 * Friendly port name (WARP-1716).
 *
 * This used to be a hardcoded `null`, which the dashboard's fallback rendered
 * as the word "Open" — so every port on a switch that had never been
 * auto-provisioned announced itself as open while carrying traffic. There is
 * still no port→MAC source on the flashed image (the rpcd ACL grants no FDB
 * read — WARP-1717), so we don't fabricate a device name. What we CAN say
 * honestly is the role the provision config assigned, and the driver's own
 * port label; a port with neither is left null for the dashboard to describe
 * by link state.
 */
export function derivePortName(args: {
  role: SwitchPortRole;
  rawName: string | null | undefined;
}): string | null {
  switch (args.role) {
    case "uplink":
      return "Uplink";
    case "camera":
      return "Camera";
    case "ap":
      return "Access point";
    case "client":
      return "Client";
    default:
      break;
  }
  const raw = args.rawName?.trim();
  // The openwrt driver labels every port "Port N", which tells the operator
  // nothing the `1/N` label doesn't already say — treat it as no name so the
  // dashboard falls through to describing the port by link state.
  if (!raw || /^port\s*\d+$/i.test(raw)) return null;
  return raw;
}

/** Byte counters, or null when the driver reported none. */
function buildPortTraffic(raw: SwitchRawPortStatus | undefined): SwitchRawTraffic | null {
  const t = raw?.traffic;
  if (!t) return null;
  if (!Number.isFinite(t.rx_bytes) || !Number.isFinite(t.tx_bytes)) return null;
  if (t.rx_bytes < 0 || t.tx_bytes < 0) return null;
  return { rx_bytes: t.rx_bytes, tx_bytes: t.tx_bytes };
}

/**
 * Status chip, in precedence order:
 *   blocked  — administratively disabled (enabled === false)
 *   offline  — link down
 *   warn     — PoE fault: a class was negotiated but the port isn't delivering
 *   online   — otherwise
 *
 * A PoE fault is only meaningful on a copper port that has a PoE row; SFP /
 * unpowered ports never warn.
 */
export function derivePortStatus(args: {
  enabled: boolean;
  linkUp: boolean;
  poe: SwitchPortPoe | null;
}): SwitchPortStatusChip {
  if (!args.enabled) return "blocked";
  if (!args.linkUp) return "offline";
  if (args.poe && args.poe.class !== null && !args.poe.delivering) return "warn";
  return "online";
}

/** Build the per-port PoE block (watts) from a raw mW row, or null. */
function buildPortPoe(raw: SwitchRawPoe | undefined): SwitchPortPoe | null {
  if (!raw) return null;
  return {
    delivering: Boolean(raw.delivering),
    power_w: mwToW(raw.power_mw),
    class: parsePoeClass(raw.class),
    max_power_w: mwToW(raw.max_power_mw),
  };
}

// --- Status ----------------------------------------------------------------

export function aggregateStatus(input: {
  connected: boolean;
  systemInfo: RawSystemInfo | null;
  poe: SwitchRawPoe[];
  config: SwitchProvisionConfig;
}): SwitchStatus {
  const { connected, systemInfo, poe, config } = input;

  let usedW = 0;
  let activePorts = 0;
  for (const row of poe) {
    if (row.delivering) {
      usedW += mwToW(row.power_mw);
      activePorts += 1;
    }
  }
  // Re-round the sum so floating accumulation can't leak (e.g. 16.599999).
  usedW = Math.round(usedW * 10) / 10;

  return {
    connected,
    model: systemInfo?.model ?? null,
    firmware: systemInfo?.firmware_version ?? null,
    auto_managed: Boolean(config.auto_managed),
    vlan_profile: normalizeVlanProfile(config.vlan_profile),
    last_provisioned_at: config.last_provisioned_at ?? null,
    protected_port: config.protected_port,
    poe_budget_w: config.poe_budget_w,
    poe_used_w: usedW,
    poe_ports_active: activePorts,
  };
}

// --- Ports -----------------------------------------------------------------

/** For each port, the VLAN it sits on (untagged member) + that VLAN's name. */
function buildPortVlanIndex(vlans: RawVlan[]): Map<number, { vlan: number; name: string }> {
  const idx = new Map<number, { vlan: number; name: string }>();
  for (const v of vlans) {
    for (const m of v.ports) {
      // A port's access VLAN is the one it's an UNTAGGED member of. Trunk
      // (tagged) memberships don't define the access VLAN, so skip them.
      if (m.member && !m.tagged) {
        idx.set(m.port, { vlan: v.vlan_id, name: v.name });
      }
    }
  }
  return idx;
}

export function aggregatePorts(input: {
  rawPorts: SwitchRawPort[];
  portStatus: SwitchRawPortStatus[];
  poe: SwitchRawPoe[];
  vlans: RawVlan[];
  config: SwitchProvisionConfig;
}): SwitchPort[] {
  const { rawPorts, portStatus, poe, vlans, config } = input;

  const statusByPort = new Map(portStatus.map((s) => [s.port, s]));
  const poeByPort = new Map(poe.map((p) => [p.port, p]));
  const vlanByPort = buildPortVlanIndex(vlans);
  const rawByPort = new Map(rawPorts.map((p) => [p.port, p]));

  // The set of ports to emit = every port the switch reported anywhere. The
  // raw port table is authoritative for the port set (always 1..N).
  const allPorts = new Set<number>([
    ...rawPorts.map((p) => p.port),
    ...portStatus.map((p) => p.port),
  ]);

  const out: SwitchPort[] = [];
  for (const port of [...allPorts].sort((a, b) => a - b)) {
    const raw = rawByPort.get(port);
    const live = statusByPort.get(port);
    const isSfp = Boolean(raw?.is_sfp ?? live?.is_sfp ?? port >= 9);

    const poeBlock = buildPortPoe(poeByPort.get(port));
    const linkUp = Boolean(live?.link_up);
    const speedRaw = live?.speed ?? "";
    const enabled = raw?.enabled ?? true;

    const vlanInfo = vlanByPort.get(port);
    // Fall back to vlan_port_stat's PVID when the port isn't an untagged
    // member in the membership read (e.g. a trunk/uplink) — never guess.
    const vlan = vlanInfo?.vlan ?? raw?.vlan ?? null;

    const role = derivePortRole(port, config);

    out.push({
      port,
      label: `1/${port}`,
      name: derivePortName({ role, rawName: raw?.name }),
      role,
      link_up: linkUp,
      speed: speedRaw === "" ? null : speedRaw,
      is_sfp: isSfp,
      vlan,
      vlan_name: vlanInfo?.name ?? null,
      poe: poeBlock,
      status: derivePortStatus({ enabled, linkUp, poe: poeBlock }),
      // Still null: the MAC→device join needs an FDB read the flashed switch
      // image's rpcd ACL doesn't grant (WARP-1717).
      device: null,
      traffic: buildPortTraffic(live),
    });
  }
  return out;
}

// --- VLANs -----------------------------------------------------------------

export function aggregateVlans(vlans: RawVlan[], config: SwitchProvisionConfig): SwitchVlan[] {
  const segmented = normalizeVlanProfile(config.vlan_profile) === "segmented";
  return vlans.map((v) => ({
    vlan_id: v.vlan_id,
    name: v.name,
    // The camera VLAN is only honestly "isolated" under the segmented profile
    // (flat-lan keeps cameras on the LAN — item 9 / §6 camera-safe note).
    isolated: v.vlan_id === CAMERA_VLAN && segmented,
    ports: v.ports.filter((m) => m.member).map((m) => m.port).sort((a, b) => a - b),
  }));
}

// --- Orchestration (calls the switch client, applies the joins) ------------

/**
 * Fallback provision-config when the switch service is unreachable / auth is
 * not configured. The §7 reads still need a config shape to derive port roles
 * and profile; absence of a switch means a flat, unmanaged default — never
 * guess a segmented layout. Matches the service's flat-lan default.
 */
const DEFAULT_PROVISION_CONFIG: SwitchProvisionConfig = {
  vlan_profile: "flat-lan",
  auto_managed: false,
  protected_port: 0,
  camera_ports: [],
  ap_ports: [],
  client_ports: [],
  poe_budget_w: 0,
  last_provisioned_at: null,
};

export async function fetchSwitchStatus(): Promise<SwitchStatus> {
  // An auth-config failure (403) must surface DISTINCTLY (auth_not_configured)
  // rather than be swallowed to the same connected:false empty state a real
  // absent switch (503) produces — see SwitchAuthError. `tracker` records
  // whether any read hit a SwitchAuthError so the status can carry the flag.
  const tracker = newAuthTracker();
  const [connected, systemInfo, poe, config] = await Promise.all([
    switchClient.healthCheck(),
    safeSystemInfo(tracker),
    // /poe raises 503 on a disconnected driver — the §7 status must still
    // answer (connected:false) from health + provision-config, so tolerate it.
    safe(switchClient.fetchPoeStatus() as Promise<SwitchRawPoe[]>, [], tracker),
    // /provision/config is disconnect-safe by design, but a 403 auth failure
    // must NOT 500 the status — fall back + record the auth flag.
    safe(switchClient.fetchProvisionConfig(), DEFAULT_PROVISION_CONFIG, tracker),
  ]);
  const status = aggregateStatus({ connected, systemInfo, poe, config });
  if (tracker.authError) status.auth_not_configured = true;
  return status;
}

export async function fetchSwitchPorts(): Promise<SwitchPort[]> {
  // A disconnected switch raises 503 on these reads; the panel gates the port
  // map on status.connected, so degrade to an empty list rather than 500. A 403
  // auth failure degrades the same way here (the status read carries the
  // distinct auth_not_configured flag the dashboard banners on).
  const [rawPorts, portStatus, poe, vlans, config] = await Promise.all([
    safe(switchClient.fetchPorts() as Promise<SwitchRawPort[]>, []),
    safe(switchClient.fetchPortStatus(), []),
    safe(switchClient.fetchPoeStatus() as Promise<SwitchRawPoe[]>, []),
    safe(switchClient.fetchVlans() as Promise<RawVlan[]>, []),
    safe(switchClient.fetchProvisionConfig(), DEFAULT_PROVISION_CONFIG),
  ]);
  return aggregatePorts({ rawPorts, portStatus, poe, vlans, config });
}

export async function fetchSwitchVlans(): Promise<SwitchVlan[]> {
  const [vlans, config] = await Promise.all([
    safe(switchClient.fetchVlans() as Promise<RawVlan[]>, []),
    safe(switchClient.fetchProvisionConfig(), DEFAULT_PROVISION_CONFIG),
  ]);
  return aggregateVlans(vlans, config);
}

/** Mutable flag carrier so `safe()` can record an auth failure across reads. */
interface AuthTracker {
  authError: boolean;
}
function newAuthTracker(): AuthTracker {
  return { authError: false };
}

/**
 * Resolve a switch-dependent read to a fallback when the driver is
 * disconnected. The switch service raises 503 (an HTTPException, NOT a
 * SwitchError) on /poe, /ports, /port_status, /vlans, /system/info when no
 * switch is attached — so the §7 reads must tolerate it and still answer
 * (status connected:false, empty port/vlan lists) so the dashboard renders its
 * calm "no managed switch" empty state instead of an error card.
 *
 * A `SwitchAuthError` (403) is ALSO swallowed to the fallback so reads never
 * 500, but — distinct from a 503 — it is recorded on the optional `tracker` so
 * the §7 status can surface `auth_not_configured: true` and the dashboard can
 * banner "Switch auth not configured" instead of the calm empty state.
 */
async function safe<T>(p: Promise<T>, fallback: T, tracker?: AuthTracker): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (tracker && err instanceof SwitchAuthError) tracker.authError = true;
    return fallback;
  }
}

async function safeSystemInfo(tracker?: AuthTracker): Promise<RawSystemInfo | null> {
  return safe(switchClient.fetchSystemInfo() as Promise<RawSystemInfo | null>, null, tracker);
}
