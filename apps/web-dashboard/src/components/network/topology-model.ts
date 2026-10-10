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
  /** What the tree couldn't tell apart, in the user's words, for the footnotes. */
  notes: string[];
}

export interface TopologyInput {
  /** A usable port map: `supported` with at least one port. */
  router: RouterPortMap;
  /** `null` when there is no reachable managed switch. `ports: null` when the
   *  switch answered but its port list never did (a read that failed, not one
   *  still on its way — the panel holds the tree back for that). */
  switch: { status: SwitchStatus; ports: SwitchPort[] | null } | null;
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
 * Pair AP rows with the switch's jacks that have a cable in them.
 *   1. by MAC, when the switch reports the device on the jack — whatever role
 *      the provisioner gave that jack;
 *   2. by elimination, when exactly one row and one cabled AP-role jack are left.
 * Anything else stays unpaired — with two of each and no MAC there is no
 * honest way to say which is which.
 */
function pairAps(aps: ApDeviceInfo[], live: SwitchPort[]) {
  const byPort = new Map<number, ApDeviceInfo>();
  const free = new Set(aps);
  for (const p of live) {
    const mac = normMac(p.device?.mac);
    const hit = mac ? aps.find((a) => free.has(a) && normMac(a.mac) === mac) : undefined;
    if (hit) {
      byPort.set(p.port, hit);
      free.delete(hit);
    }
  }
  const openAp = live.filter((p) => p.role === "ap" && !byPort.has(p.port));
  if (free.size === 1 && openAp.length === 1) {
    byPort.set(openAp[0].port, [...free][0]);
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

/** An AP-role jack with a cable and no row to name it: an AP we know nothing else about. */
function anonymousAp(p: SwitchPort): TopologyNode {
  return {
    id: `switch-port-${p.port}`,
    kind: "access-point",
    name: leafName(p, "Access point"),
    status: "Wi-Fi details unavailable",
    tone: "neutral",
    meta: portMeta(p),
    children: [],
  };
}

const byPortNo = (a: SwitchPort, b: SwitchPort) => a.port - b.port;

/** "one of ports 2, 3, 5" / "2 of ports 2, 3, 5" — cables we can count but not place. */
function someOf(count: number, jacks: SwitchPort[]): string {
  const ids = jacks.map((p) => p.port).join(", ");
  return count === 1 ? `one of ports ${ids}` : `${count} of ports ${ids}`;
}

/** Where a row the switch can't name must be: the jacks it can't explain, and
 *  the router too when that has a spare cable. One candidate is only named
 *  when there is nowhere else it could be. */
function unplacedMeta(candidates: SwitchPort[], orRouter: boolean): string {
  if (candidates.length === 1) {
    return orRouter ? `port ${candidates[0].port} or the router` : portMeta(candidates[0]);
  }
  const list = someOf(1, candidates);
  return orRouter ? `${list}, or the router` : list;
}

/** Cabled AP-role jacks beyond the rows we have: real units, still unnamed. */
function pooledAps(count: number, jacks: SwitchPort[]): TopologyNode {
  return {
    id: "switch-ap-pool",
    kind: "access-point",
    name: count === 1 ? "Access point" : `${count} access points`,
    status: "Wi-Fi details unavailable",
    tone: "neutral",
    meta: someOf(count, jacks),
    children: [],
  };
}

/** Unlabelled cabled jacks once the APs that must be on some of them are taken out. */
function pooledLeaves(count: number, jacks: SwitchPort[]): TopologyNode {
  return {
    id: "switch-other-devices",
    kind: "device",
    name: count === 1 ? "Wired device" : `${count} wired devices`,
    status: "Connected",
    tone: "ok",
    meta: someOf(count, jacks),
    children: [],
  };
}

const UNLABELLED_PORTS =
  "This switch's ports aren't labelled, so its access points and cameras can't be told apart from other wired devices.";
const UNLABELLED_PORTS_AND_UPLINK =
  "This switch's ports aren't labelled, so its uplink, access points and cameras can't be told apart from other wired devices.";
const PORTS_UNREAD = "We couldn't read the switch's ports, so what's plugged into it isn't shown.";

interface SwitchBuild {
  node: TopologyNode;
  uplink: SwitchPort | undefined;
  /** AP rows this switch has no cabled jack for: they hang off the router instead. */
  overflow: ApDeviceInfo[];
  notes: string[];
}

/**
 * The switch and what hangs off it. Every cabled jack is drawn exactly once:
 * as the AP row the switch names (by MAC) or the one left by elimination, as a
 * camera or wired device by its role, or pooled — "2 wired devices · 2 of
 * ports 1, 5, 6" — when rows the switch can't name must be on some of them.
 * A row with no jack that could hold it isn't on this switch at all and is
 * handed back to the router.
 */
function buildSwitch(
  sw: NonNullable<TopologyInput["switch"]>,
  aps: ApDeviceInfo[],
  hint: ApWifiHint,
  routerHasSpareCable: boolean,
): SwitchBuild {
  const { status, ports } = sw;
  const name = status.model?.trim() || "Switch";

  if (ports === null) {
    // The switch answered, its port list didn't. Nothing can be hung off it
    // honestly, so its APs are the router's to place.
    return {
      uplink: undefined,
      overflow: aps,
      notes: [PORTS_UNREAD],
      node: { id: "switch", kind: "switch", name, status: "Ports unavailable", tone: "warn", children: [] },
    };
  }

  const isUplink = (p: SwitchPort) =>
    p.role === "uplink" || (!!status.protected_port && p.port === status.protected_port);
  const uplink = ports.find(isUplink);
  const live = ports
    .filter((p) => p.link_up && !isUplink(p))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.port - b.port);

  const { byPort, unplaced } = pairAps(aps, live);
  const openAp = live.filter((p) => p.role === "ap" && !byPort.has(p.port));
  const cameras = live.filter((p) => p.role === "camera" && !byPort.has(p.port));
  const others = live.filter((p) => p.role !== "ap" && p.role !== "camera" && !byPort.has(p.port));

  const children: TopologyNode[] = live
    .filter((p) => byPort.has(p.port))
    .map((p) => apNode(byPort.get(p.port)!, p, hint));
  let overflow: ApDeviceInfo[] = [];

  if (unplaced.length === 0) {
    children.push(...openAp.map(anonymousAp), ...cameras.map(portLeaf), ...others.map(portLeaf));
  } else if (openAp.length === 0 && others.length === 0) {
    // Every cabled jack is spoken for, so these rows aren't on this switch.
    overflow = unplaced;
    children.push(...cameras.map(portLeaf));
  } else {
    // Rows the switch can't name are on the jacks it can't explain: the
    // AP-role ones when there are enough of those, else those and the
    // unlabelled ones. Which is which is never guessed.
    const onApJacks = unplaced.length <= openAp.length;
    const candidates = (onApJacks ? openAp : [...openAp, ...others]).sort(byPortNo);
    const where = unplacedMeta(candidates, routerHasSpareCable);
    children.push(...unplaced.map((a) => ({ ...apNode(a, null, hint), meta: where })));

    const extraAp = openAp.length - unplaced.length;
    if (extraAp > 0) children.push(pooledAps(extraAp, openAp));
    children.push(...cameras.map(portLeaf));
    if (onApJacks) {
      children.push(...others.map(portLeaf));
    } else {
      const spare = others.length - (unplaced.length - openAp.length);
      if (spare > 0) children.push(pooledLeaves(spare, [...others].sort(byPortNo)));
    }
  }

  const notes: string[] = [];
  if (ports.some((p) => p.link_up) && ports.every((p) => p.role === "unknown")) {
    notes.push(uplink ? UNLABELLED_PORTS : UNLABELLED_PORTS_AND_UPLINK);
  }

  const inUse = ports.filter((p) => p.link_up).length;
  return {
    uplink,
    overflow,
    notes,
    node: {
      id: "switch",
      kind: "switch",
      name,
      status: ports.length === 0 ? "No ports reported" : `${inUse} of ${ports.length} ports in use`,
      tone: ports.length === 0 ? "neutral" : "ok",
      meta: uplink ? [`uplink port ${uplink.port}`, uplink.speed].filter(Boolean).join(" · ") : undefined,
      children,
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
 * Each entity (the switch, and any AP not on it) takes exactly one of the
 * jacks that have a cable. The router doesn't say which, so a jack is claimed
 * only when it is the single candidate whose speed agrees with the far end —
 * a link has one speed — and no other entity needs that same jack. Settling
 * one can settle the next by elimination (the 1 Gb switch can only be on p2,
 * so the AP is on p3), but only while every entity really has a jack of its
 * own: with more entities than cables something is stale, and nothing is
 * claimed. Every other cable is a plain wired device; if the jack can't be
 * settled, those are pooled with the jacks they might be on rather than
 * assigned arbitrarily.
 */
function attachToRouter(lan: RouterPort[], entities: RouterEntity[]): TopologyNode[] {
  if (entities.length === 0) return lan.map(directDevice);

  const jacks = new Set(lan);
  const claimed = new Map<RouterEntity, RouterPort>();
  if (entities.length <= lan.length) {
    for (let settled = true; settled; ) {
      settled = false;
      const open = entities.filter((e) => !claimed.has(e));
      const fits = new Map(open.map((e) => [e, [...jacks].filter((p) => speedsAgree(p.speed, e.speed))]));
      for (const e of open) {
        const only = fits.get(e)!;
        if (only.length !== 1 || !jacks.has(only[0])) continue;
        const rival = open.some((o) => o !== e && fits.get(o)!.length === 1 && fits.get(o)![0] === only[0]);
        if (rival) continue;
        claimed.set(e, only[0]);
        jacks.delete(only[0]);
        settled = true;
      }
    }
  }

  const nodes = entities.map((e) => (claimed.has(e) ? e.claim(claimed.get(e)!) : e.node));
  const left = lan.filter((p) => jacks.has(p));
  const unsettled = entities.length - claimed.size;
  if (unsettled === 0) return [...nodes, ...left.map(directDevice)];
  const spare = left.length - unsettled;
  return [...nodes, ...(spare > 0 ? [pooledDevices(left, spare)] : [])];
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
  const notes: string[] = [];

  /** An AP on one of the router's own cables — which one, attachToRouter decides. */
  const routerAp = (ap: ApDeviceInfo): RouterEntity => {
    const node = apNode(ap, null, hint);
    return { node, speed: null, claim: (jack) => ({ ...node, meta: `router ${jack.id}` }) };
  };

  const entities: RouterEntity[] = [];
  if (input.switch) {
    // The switch takes one router cable; any other cable could hold an AP.
    const built = buildSwitch(input.switch, shown, hint, lan.length > 1);
    const { node, uplink } = built;
    notes.push(...built.notes);
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
    entities.push(...built.overflow.map(routerAp));
  } else {
    // No switch to hold them: each AP is a cable straight into the router.
    entities.push(...shown.map(routerAp));
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

  return { root, hint, notes };
}
