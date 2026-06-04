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

    out.push({
      port,
      label: `1/${port}`,
      // v1: friendly name + device deferred (LLDP/MAC→device join).
      name: null,
      role: derivePortRole(port, config),
      link_up: linkUp,
      speed: speedRaw === "" ? null : speedRaw,
      is_sfp: isSfp,
      vlan,
      vlan_name: vlanInfo?.name ?? null,
      poe: poeBlock,
      status: derivePortStatus({ enabled, linkUp, poe: poeBlock }),
      device: null,
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

export async function fetchSwitchStatus(): Promise<SwitchStatus> {
  const [connected, systemInfo, poe, config] = await Promise.all([
    switchClient.healthCheck(),
    safeSystemInfo(),
    switchClient.fetchPoeStatus() as Promise<SwitchRawPoe[]>,
    switchClient.fetchProvisionConfig(),
  ]);
  return aggregateStatus({ connected, systemInfo, poe, config });
}

export async function fetchSwitchPorts(): Promise<SwitchPort[]> {
  const [rawPorts, portStatus, poe, vlans, config] = await Promise.all([
    switchClient.fetchPorts() as Promise<SwitchRawPort[]>,
    switchClient.fetchPortStatus(),
    switchClient.fetchPoeStatus() as Promise<SwitchRawPoe[]>,
    switchClient.fetchVlans() as Promise<RawVlan[]>,
    switchClient.fetchProvisionConfig(),
  ]);
  return aggregatePorts({ rawPorts, portStatus, poe, vlans, config });
}

export async function fetchSwitchVlans(): Promise<SwitchVlan[]> {
  const [vlans, config] = await Promise.all([
    switchClient.fetchVlans() as Promise<RawVlan[]>,
    switchClient.fetchProvisionConfig(),
  ]);
  return aggregateVlans(vlans, config);
}

/**
 * system-info read that tolerates a disconnected switch. The service returns
 * 503 on /system/info when the driver isn't connected; the §7 status must
 * still answer (connected:false, model:null) using provision-config, so a
 * failed read resolves to null rather than throwing.
 */
async function safeSystemInfo(): Promise<RawSystemInfo | null> {
  try {
    return (await switchClient.fetchSystemInfo()) as RawSystemInfo;
  } catch {
    return null;
  }
}
