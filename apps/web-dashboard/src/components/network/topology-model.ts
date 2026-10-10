import type { ApDeviceInfo, WirelessRadioSummary } from "@/lib/types";
import type { ApWirelessDetail, DeploymentPosture } from "@/lib/api";
import type { RouterPort, RouterPortMap } from "@/lib/types/router-ports";
import type { SwitchPort, SwitchStatus } from "@/lib/types/switch";
import { linkSummary } from "./router/helpers";
import { STATUS_TONE, formatWatts } from "./switch/helpers";

/**
 * The Network → Overview topology tree, as data.
 *
 * Pure on purpose (no React, no fetching): `buildTopology` folds the router's
 * port map, the managed switch's ports and the coverage-AP list into one tree,
 * and `TopologyPanel` only draws what comes out. The arithmetic that decides
 * where things hang is the part that can quietly lie, so it lives where a unit
 * test can reach it.
 *
 * Three honesty rules shape every placement below:
 *   * the router reports no neighbour per jack and the switch reports no
 *     port → device join yet (its `device` is null until the FDB read lands),
 *     so a cable is only attributed to a jack when the evidence leaves exactly
 *     one candidate. Otherwise the node is drawn without a port and the
 *     candidates are named, never guessed between;
 *   * a port is "in use" only with link up. The switch's roles are the
 *     provisioner's assignment, not a detection, so a camera-role jack with no
 *     cable is nothing, not a camera;
 *   * an access point whose radios can't be read says so. A silent AP and an
 *     AP with no clients are different facts and only one of them is an outage.
 */

/** The dot vocabulary the router and switch faceplates already use. */
export type TopologyTone = "ok" | "warn" | "neutral" | "err";

export type TopologyKind =
  | "internet"
  | "upstream"
  | "router"
  | "switch"
  | "access-point"
  | "camera"
  | "computer"
  | "device";

export interface TopologyAp {
  mac: string;
  /** An ONLINE Droplet-image AP — the only kind whose radios the orchestrator
   *  can read (the same gate `ApRadioDetail` mounts behind). */
  readable: boolean;
}

export interface TopologyNode {
  /** Unique among siblings: the React key and the test handle. */
  id: string;
  kind: TopologyKind;
  name: string;
  /** One line. Empty means "nothing known" — the card draws no dot for it. */
  status: string;
  tone: TopologyTone;
  /** Where it plugs in, in mono ("port 3 · 1 Gb", "router p2"). */
  meta?: string;
  ap?: TopologyAp;
  children: TopologyNode[];
}

export interface TopologyModel {
  root: TopologyNode;
  hint: ApWifiHint;
}

export interface TopologyInput {
  /** A usable port map: `supported` with at least one port. */
  router: RouterPortMap;
  /** `null` when there is no reachable managed switch. */
  switch: { status: SwitchStatus; ports: SwitchPort[] } | null;
  /** GET /api/aps, unfiltered — this decides which rows belong in the tree. */
  aps: ApDeviceInfo[];
  posture?: DeploymentPosture | null;
  /** The whole-fabric rollup off /network/status, which every role can read. */
  radios?: WirelessRadioSummary;
}

// ── Access-point Wi-Fi ────────────────────────────────────────────────

/**
 * What we know about one AP's radios.
 *   pending       — the read is in flight
 *   restricted    — this viewer can't read per-AP detail (owner/admin only);
 *                   only the fabric rollup is left to go on
 *   not-reporting — the AP is ONLINE but didn't answer, or said it has no
 *                   wireless state
 *   reporting     — it answered; `clients` is null when no radio gave a count
 */
export type ApRadioRead =
  | { state: "pending" }
  | { state: "restricted" }
  | { state: "not-reporting" }
  | { state: "reporting"; radios: number; onAir: number; clients: number | null };

/** From the rollup: true when every readable online AP failed to report. */
export interface ApWifiHint {
  allSilent: boolean;
}

/** Raw `/api/aps/:mac/wireless` read → `ApRadioRead`. A failed read wins over
 *  stale data: an AP that stopped answering must not keep its old client count. */
export function toApRadioRead(args: {
  enabled: boolean;
  detail: ApWirelessDetail | undefined;
  failed: boolean;
}): ApRadioRead {
  if (!args.enabled) return { state: "restricted" };
  if (args.failed) return { state: "not-reporting" };
  if (!args.detail) return { state: "pending" };
  if (!args.detail.supported) return { state: "not-reporting" };
  const radios = args.detail.radios ?? [];
  const counts = radios
    .map((r) => r.clients)
    .filter((c): c is number => typeof c === "number");
  return {
    state: "reporting",
    radios: radios.length,
    // `up` is null on an image that doesn't report link state; uci's
    // `disabled` is then all there is — the rule `getApRadioSummary` uses.
    onAir: radios.filter((r) => !r.disabled && r.up !== false).length,
    clients: counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The AP card's one-line Wi-Fi status. */
export function describeApWifi(
  read: ApRadioRead,
  hint: ApWifiHint,
): { status: string; tone: TopologyTone } {
  switch (read.state) {
    case "pending":
      return { status: "Checking radios…", tone: "neutral" };
    case "not-reporting":
      return { status: "Radios not reporting", tone: "warn" };
    case "restricted":
      return hint.allSilent
        ? { status: "Radios not reporting", tone: "warn" }
        : { status: "Online", tone: "ok" };
    case "reporting": {
      const { radios, onAir, clients } = read;
      if (radios === 0) return { status: "No radios found", tone: "warn" };
      if (onAir === 0) return { status: "Radios are off", tone: "warn" };
      const partial = onAir < radios;
      if (clients === null) {
        const radiosOn = partial
          ? `${onAir} of ${plural(radios, "radio")}`
          : plural(radios, "radio");
        return { status: `${radiosOn} on the air`, tone: partial ? "warn" : "ok" };
      }
      const people = clients === 0 ? "No clients" : plural(clients, "client");
      return {
        status: partial ? `${people} · ${onAir} of ${plural(radios, "radio")} on` : people,
        tone: partial ? "warn" : "ok",
      };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** "2.5 Gb" / "1 Gb" / "100 Mb" / "2500 Mb" → Mbit/s; null when none reported. */
export function parseMbps(speed: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([GM])/i.exec(speed ?? "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2].toUpperCase() === "G" ? n * 1000 : n);
}

/** Two ends of one cable negotiate one speed; an unreported end can't object. */
function speedsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseMbps(a);
  const y = parseMbps(b);
  return x === null || y === null || x === y;
}

function normMac(mac: string | null | undefined): string {
  return (mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** Rows that are physically on the LAN. Discovery noise and removed units aren't. */
export function isTopologyAp(ap: ApDeviceInfo): boolean {
  return (
    ap.status === "ONLINE" ||
    ap.status === "PROVISIONING" ||
    ap.status === "FAILED" ||
    ap.status === "AWAITING_APPROVAL"
  );
}

const isReadableAp = (ap: ApDeviceInfo) => ap.status === "ONLINE" && ap.backend === "DROPLET_IMAGE";

/** The orchestrator's own naming rule (`infraApIndex`), so the tree and the
 *  Devices list call the same unit the same thing. */
function apName(ap: ApDeviceInfo): string {
  return ap.displayName?.trim() || ap.model?.trim() || "Access point";
}

// ── Access points ─────────────────────────────────────────────────────

function apBaseline(ap: ApDeviceInfo, hint: ApWifiHint): { status: string; tone: TopologyTone } {
  switch (ap.status) {
    case "PROVISIONING":
      return { status: "Setting up…", tone: "neutral" };
    case "AWAITING_APPROVAL":
      return { status: "Waiting for approval", tone: "warn" };
    case "FAILED":
      return { status: "Needs attention", tone: "err" };
    default:
      return isReadableAp(ap)
        ? describeApWifi({ state: "restricted" }, hint)
        : { status: "Online", tone: "ok" };
  }
}

/** "port 4 · PoE 5.2 W" — the wiring half of a switch-port card. */
function portMeta(p: SwitchPort): string {
  const tail = p.poe?.delivering ? `PoE ${formatWatts(p.poe.power_w)}` : p.speed;
  return [`port ${p.port}`, tail].filter(Boolean).join(" · ");
}

function apNode(ap: ApDeviceInfo, port: SwitchPort | null, hint: ApWifiHint): TopologyNode {
  return {
    id: `ap-${normMac(ap.mac)}`,
    kind: "access-point",
    name: apName(ap),
    ...apBaseline(ap, hint),
    meta: port ? portMeta(port) : "port not identified",
    ap: { mac: ap.mac, readable: isReadableAp(ap) },
    children: [],
  };
}

/**
 * Pair AP rows with the switch's AP-role jacks that have a cable in them.
 *   1. by MAC, when the switch reports the device on the jack;
 *   2. by elimination, when exactly one row and one jack are left.
 * Anything else stays unpaired — with two of each and no MAC there is no
 * honest way to say which is which.
 */
function pairAps(aps: ApDeviceInfo[], ports: SwitchPort[]) {
  const apPorts = ports.filter((p) => p.role === "ap" && p.link_up);
  const byPort = new Map<number, ApDeviceInfo>();
  const free = new Set(aps);
  for (const p of apPorts) {
    const mac = normMac(p.device?.mac);
    const hit = mac ? aps.find((a) => free.has(a) && normMac(a.mac) === mac) : undefined;
    if (hit) {
      byPort.set(p.port, hit);
      free.delete(hit);
    }
  }
  const open = apPorts.filter((p) => !byPort.has(p.port));
  if (free.size === 1 && open.length === 1) {
    byPort.set(open[0].port, [...free][0]);
    free.clear();
  }
  return { byPort, unplaced: aps.filter((a) => free.has(a)) };
}

// ── The switch ────────────────────────────────────────────────────────

const ROLE_ORDER: Record<SwitchPort["role"], number> = {
  ap: 0,
  camera: 1,
  client: 2,
  unknown: 3,
  uplink: 4,
};

/** Names the provisioner stamps on a jack by role — not a device's own name. */
const GENERIC_PORT_NAME = /^(access point|ap|camera|client|uplink|port\s*\d+)$/i;

function leafName(p: SwitchPort, fallback: string): string {
  const named = p.device?.name?.trim() || p.name?.trim();
  return named && !GENERIC_PORT_NAME.test(named) ? named : fallback;
}

function portLeaf(p: SwitchPort): TopologyNode {
  const poe = p.poe?.delivering ? p.poe : null;
  return {
    id: `switch-port-${p.port}`,
    kind: p.role === "camera" ? "camera" : p.role === "client" ? "computer" : "device",
    name: leafName(p, p.role === "camera" ? "Camera" : "Wired device"),
    status: poe ? `PoE ${formatWatts(poe.power_w)}` : (p.speed ?? "Connected"),
    tone: STATUS_TONE[p.status],
    meta: portMeta(p),
    children: [],
  };
}

function buildSwitch(
  sw: NonNullable<TopologyInput["switch"]>,
  aps: ApDeviceInfo[],
  hint: ApWifiHint,
): { node: TopologyNode; uplink: SwitchPort | undefined } {
  const { status, ports } = sw;
  const isUplink = (p: SwitchPort) =>
    p.role === "uplink" || (!!status.protected_port && p.port === status.protected_port);
  const uplink = ports.find(isUplink);
  const live = ports
    .filter((p) => p.link_up && !isUplink(p))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.port - b.port);

  const { byPort, unplaced } = pairAps(aps, ports);
  const apNodes: TopologyNode[] = [];
  const others: TopologyNode[] = [];
  for (const p of live) {
    if (p.role !== "ap") {
      others.push(portLeaf(p));
      continue;
    }
    const ap = byPort.get(p.port);
    if (ap) {
      apNodes.push(apNode(ap, p, hint));
    } else if (unplaced.length === 0) {
      // An AP-role jack with a cable and no row to name it. If rows are still
      // unplaced they are what's plugged in there; otherwise it's an AP we
      // know nothing else about.
      apNodes.push({
        id: `switch-port-${p.port}`,
        kind: "access-point",
        name: leafName(p, "Access point"),
        status: "Wi-Fi details unavailable",
        tone: "neutral",
        meta: portMeta(p),
        children: [],
      });
    }
  }
  apNodes.push(...unplaced.map((a) => apNode(a, null, hint)));

  const inUse = ports.filter((p) => p.link_up).length;
  return {
    uplink,
    node: {
      id: "switch",
      kind: "switch",
      name: status.model?.trim() || "Switch",
      status: ports.length === 0 ? "No ports reported" : `${inUse} of ${ports.length} ports in use`,
      tone: ports.length === 0 ? "neutral" : "ok",
      meta: uplink ? [`uplink port ${uplink.port}`, uplink.speed].filter(Boolean).join(" · ") : undefined,
      children: [...apNodes, ...others],
    },
  };
}

// ── The router ────────────────────────────────────────────────────────

/** A jack that carries the LAN side and has a cable in it. */
const isInUseLanPort = (p: RouterPort) => p.link_up && p.role !== "wan" && p.role !== "unused";

function directDevice(p: RouterPort): TopologyNode {
  return {
    id: `router-${p.id}`,
    kind: "device",
    name: "Wired device",
    status: p.speed ?? "Connected",
    tone: "ok",
    meta: `router ${p.id}`,
    children: [],
  };
}

/** Cables whose jack we can't pin down: how many, and which jacks they might be on. */
function pooledDevices(lan: RouterPort[], count: number): TopologyNode {
  const ids = lan.map((p) => p.id);
  return {
    id: "router-other-devices",
    kind: "device",
    name: count === 1 ? "Wired device" : `${count} wired devices`,
    status: "Connected",
    tone: "ok",
    meta: count === 1 ? `router ${ids.join(" or ")}` : `${count} of router ${ids.join(", ")}`,
    children: [],
  };
}

interface RouterEntity {
  node: TopologyNode;
  /** The cable's negotiated speed as the far end reports it, if it does. */
  speed: string | null;
  /** The same node once its router jack is known. */
  claim: (jack: RouterPort) => TopologyNode;
}

/**
 * Hang the router's cables.
 *
 * Each entity (the switch, or an AP when there is no switch) takes exactly one
 * of the jacks that have a cable. The router doesn't say which, so a jack is
 * claimed only when it is the single candidate whose speed agrees with the far
 * end — a link has one speed. Every other cable is a plain wired device; if
 * the jack can't be settled, those are pooled with the jacks they might be on
 * rather than assigned arbitrarily.
 */
function attachToRouter(lan: RouterPort[], entities: RouterEntity[]): TopologyNode[] {
  if (entities.length === 0) return lan.map(directDevice);
  if (entities.length === 1) {
    const [only] = entities;
    const fits = lan.filter((p) => speedsAgree(p.speed, only.speed));
    if (fits.length === 1) {
      return [only.claim(fits[0]), ...lan.filter((p) => p !== fits[0]).map(directDevice)];
    }
  }
  const spare = lan.length - entities.length;
  return [...entities.map((e) => e.node), ...(spare > 0 ? [pooledDevices(lan, spare)] : [])];
}

// ── The tree ──────────────────────────────────────────────────────────

function wanLine(wan: RouterPort | undefined): { status: string; tone: TopologyTone } {
  if (!wan) return { status: "", tone: "neutral" };
  if (wan.status === "disabled") return { status: "turned off", tone: "err" };
  if (!wan.present) return { status: "no reading", tone: "neutral" };
  if (wan.link_up) return { status: `${wan.speed ?? "connected"} · ${wan.id}`, tone: "ok" };
  return { status: "no cable", tone: "neutral" };
}

export function buildTopology(input: TopologyInput): TopologyModel {
  const { router, posture, radios } = input;
  const shown = input.aps.filter(isTopologyAp);
  const readable = shown.filter(isReadableAp).length;
  const hint: ApWifiHint = {
    allSilent: readable > 0 && (radios?.apsNotReporting ?? 0) >= readable,
  };
  const lan = router.ports.filter(isInUseLanPort);

  const entities: RouterEntity[] = [];
  if (input.switch) {
    const { node, uplink } = buildSwitch(input.switch, shown, hint);
    entities.push({
      node,
      speed: uplink?.speed ?? null,
      claim: (jack) => ({
        ...node,
        meta: [
          uplink ? `router ${jack.id} ↔ port ${uplink.port}` : `router ${jack.id}`,
          uplink?.speed,
        ]
          .filter(Boolean)
          .join(" · "),
      }),
    });
  } else {
    // No switch to hold them: each AP is a cable straight into the router.
    for (const ap of shown) {
      const node = apNode(ap, null, hint);
      entities.push({
        node,
        speed: null,
        claim: (jack) => ({ ...node, meta: `router ${jack.id}` }),
      });
    }
  }

  const routerNode: TopologyNode = {
    id: "router",
    kind: "router",
    name: router.model?.trim() || "Router",
    status: linkSummary(router.ports),
    tone: "ok",
    children: attachToRouter(lan, entities),
  };

  const wan = wanLine(router.ports.find((p) => p.role === "wan"));
  const root: TopologyNode =
    posture === "DOWNSTREAM_ROUTER"
      ? {
          id: "upstream",
          kind: "upstream",
          name: "Upstream router",
          ...wan,
          meta: "your existing router",
          children: [routerNode],
        }
      : { id: "internet", kind: "internet", name: "Internet", ...wan, children: [routerNode] };

  return { root, hint };
}
