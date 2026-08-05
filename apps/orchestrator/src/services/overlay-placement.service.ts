/**
 * WARP-1758 — where does this box actually live, and how can a client reach it?
 *
 * Remote access has to work in two shapes the customer never tells us about:
 * the Droplet's router IS the edge router holding a public IP, or the Droplet
 * lives in a subnet behind a router someone else owns. The box has to work out
 * which on its own, keep working out it when the answer changes (a DHCP lease
 * renews, a WAN fails over, the box is physically moved), and offer the client
 * something dial-able either way.
 *
 * Before this, the overlay had exactly one candidate — the STUN-reflexive
 * mapping — and one line of topology model: reflexive port == 51820 ⇒
 * "port_preserving", else "symmetric", used only as a telemetry label. Nothing
 * branched on it, the box's own WAN address was never consulted, and a client
 * on the same LAN still had to go out to HQ and punch back in.
 *
 * Everything here is PURE. Observations are gathered by the caller and passed
 * in, so every placement the fleet can be in is a table-driven test rather than
 * something only reproducible on real hardware.
 */

/** What the box concluded about its own position on the network. */
export type WanPlacement =
  /** The box's WAN address IS its public address — it is the edge router.
   *  A client can dial it directly; no punch, no rendezvous. */
  | "edge_public"
  /** Private WAN address, public reflexive address: exactly one NAT in front,
   *  i.e. the box lives in someone else's subnet. Punchable, and better still
   *  with a port map. */
  | "behind_nat"
  /** The public-facing address is itself carrier-grade NAT (100.64.0.0/10) or
   *  otherwise unroutable. Inbound is not obtainable; this is the case that
   *  needs a relay. */
  | "cgnat"
  /** Not enough observation to say. Never guess — an honest unknown lets the
   *  caller fall back rather than advertise a wrong endpoint. */
  | "unknown";

/**
 * How the upstream NAT maps our source port.
 *
 * `endpoint_independent` — the same internal port maps to the same external
 * mapping regardless of destination, so the mapping STUN observed is the one
 * the client will see. This is what makes a punch work.
 *
 * `address_dependent` — the mapping changes per destination (classically
 * "symmetric"). The mapping STUN observed is NOT the one the client will hit,
 * so advertising it is a lie; that candidate must be withheld.
 *
 * `unknown` — only one sample. Deliberately NOT inferred from the old
 * port == 51820 heuristic, which cannot distinguish these at all: a
 * port-preserving symmetric NAT passes it and a port-rewriting cone NAT fails
 * it, so it produced both false negatives and false positives.
 */
export type NatClass = "endpoint_independent" | "address_dependent" | "unknown";

export interface PlacementObservation {
  /** The box's own WAN interface address (device-bridge `/host/uplink-ip`). */
  wanAddress: string | null;
  /** STUN-reflexive mapping as `ip:port`, or null when the probe failed. */
  reflexive: string | null;
  /** A second reflexive mapping observed toward a DIFFERENT STUN destination.
   *  Comparing the two is the only honest way to tell endpoint-independent
   *  from address-dependent mapping. Optional: absent ⇒ NatClass "unknown". */
  reflexiveAlt?: string | null;
}

export interface PlacementResult {
  placement: WanPlacement;
  natClass: NatClass;
  /** The box's public-facing IP, when one was observed. */
  publicIp: string | null;
  /** The public-facing UDP port, when one was observed. */
  publicPort: number | null;
  /** Operator-facing explanation. Never customer copy — it names addresses. */
  reason: string;
}

/** RFC1918 + loopback + link-local. Not CGNAT — that is classified separately
 *  because it means something different for reachability. */
export function isPrivateIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  return false;
}

/** RFC6598 carrier-grade NAT space, 100.64.0.0/10. A public-looking address in
 *  this range is the tell that the ISP itself is NATing us. */
export function isCgnatIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** Routable on the public internet: not private, not CGNAT, not multicast or
 *  reserved. */
export function isPublicIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return false;
  if (isPrivateIpv4(ip) || isCgnatIpv4(ip)) return false;
  if (o[0] === 0 || o[0] >= 224) return false; // unspecified, multicast, reserved
  return true;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

/** Split `ip:port`. Returns null on anything malformed — fail closed. */
export function splitEndpoint(
  endpoint: string,
): { ip: string; port: number } | null {
  const idx = endpoint.lastIndexOf(":");
  if (idx <= 0) return null;
  const ip = endpoint.slice(0, idx).trim();
  const port = Number(endpoint.slice(idx + 1).trim());
  if (!parseIpv4(ip)) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { ip, port };
}

/**
 * Classify the box's placement from what was observed.
 *
 * The core comparison is the box's OWN WAN address against the address the
 * outside world sees. Equal ⇒ nothing is translating us, so we are the edge.
 * Different ⇒ something in front is, so we live in someone else's subnet. That
 * single comparison is what the whole feature turns on, and it is why the WAN
 * address had to be observed at all — the reflexive mapping alone can never
 * distinguish the two.
 */
export function classifyPlacement(obs: PlacementObservation): PlacementResult {
  const natClass = classifyNat(obs.reflexive, obs.reflexiveAlt ?? null);
  const wan = (obs.wanAddress ?? "").trim();
  const reflexive = obs.reflexive ? splitEndpoint(obs.reflexive) : null;

  if (!reflexive) {
    return {
      placement: "unknown",
      natClass,
      publicIp: null,
      publicPort: null,
      reason:
        "No STUN observation — the box cannot tell how the outside world sees it.",
    };
  }

  const base = { publicIp: reflexive.ip, publicPort: reflexive.port, natClass };

  // The ISP is NATing us. Nothing we do upstream obtains an inbound path, so
  // say so plainly rather than offering a candidate that cannot work.
  if (isCgnatIpv4(reflexive.ip)) {
    return {
      ...base,
      placement: "cgnat",
      reason: `Public-facing address ${reflexive.ip} is carrier-grade NAT (100.64.0.0/10) — inbound connections are not obtainable on this network.`,
    };
  }

  if (!isPublicIpv4(reflexive.ip)) {
    return {
      ...base,
      placement: "unknown",
      reason: `Public-facing address ${reflexive.ip} is not routable — the STUN observation cannot be trusted.`,
    };
  }

  if (!wan) {
    // A public reflexive address with no idea what our own WAN is. We can still
    // offer the reflexive candidate, but we must not claim to be the edge.
    return {
      ...base,
      placement: "unknown",
      reason:
        "The box's own WAN address is unavailable, so edge-vs-behind-NAT can't be determined.",
    };
  }

  if (isCgnatIpv4(wan)) {
    return {
      ...base,
      placement: "cgnat",
      reason: `The box's WAN address ${wan} is carrier-grade NAT — it sits behind the ISP's own NAT.`,
    };
  }

  if (wan === reflexive.ip) {
    return {
      ...base,
      placement: "edge_public",
      reason: `The box's WAN address ${wan} is what the outside world sees — it is the edge router and can be dialled directly.`,
    };
  }

  return {
    ...base,
    placement: "behind_nat",
    reason: `The box's WAN address ${wan} differs from its public address ${reflexive.ip} — it lives behind another router.`,
  };
}

/** Two reflexive observations toward DIFFERENT destinations. Same mapping ⇒
 *  endpoint-independent (punchable); different ⇒ address-dependent. */
export function classifyNat(
  reflexive: string | null,
  reflexiveAlt: string | null,
): NatClass {
  if (!reflexive || !reflexiveAlt) return "unknown";
  const a = splitEndpoint(reflexive);
  const b = splitEndpoint(reflexiveAlt);
  if (!a || !b) return "unknown";
  return a.ip === b.ip && a.port === b.port
    ? "endpoint_independent"
    : "address_dependent";
}

/** A port mapping obtained from the upstream gateway (PCP / NAT-PMP / UPnP). */
export interface PortMapping {
  host: string;
  port: number;
}

export interface CandidateInput {
  placement: PlacementResult;
  /** The box's LAN-facing address, for a client already on the home network.
   *  Only used when it is actually private — see the gate in
   *  {@link buildCandidates}; the probe behind it can return a public address. */
  lanAddress: string | null;
  /** A stable mapping obtained from the upstream gateway, if any. */
  mapping: PortMapping | null;
  /** The port wg0 listens on. */
  listenPort: number;
}

export interface EndpointCandidate {
  kind: "lan" | "direct" | "mapped" | "srflx" | "relay";
  host: string;
  port: number;
  priority: number;
}

/**
 * Priorities. Ordering is the contract clients depend on — they try candidates
 * top-down and keep the first that completes a handshake.
 *
 * LAN outranks everything: when the client is already on the home network it is
 * the fastest path AND it needs no HQ round trip at all. It costs one failed
 * handshake attempt when the client is remote, which is far cheaper than
 * routing home traffic out through a punch.
 */
const PRIORITY = {
  lan: 120,
  direct: 100,
  mapped: 80,
  srflx: 60,
  relay: 20,
} as const;

/**
 * Build the ordered candidate list a client should try.
 *
 * The interesting decisions are the OMISSIONS:
 *
 *  - `srflx` is withheld under `address_dependent` NAT. The mapping STUN saw
 *    is per-destination, so it is not the mapping the client would hit —
 *    advertising it would send the client at an address that cannot answer.
 *  - `srflx` is withheld under `edge_public` as redundant: it would be the same
 *    address as `direct`, and a duplicate just costs a wasted attempt.
 *  - `direct` is only emitted when we actually established we are the edge.
 *    A public reflexive address alone does not prove it.
 *  - `lan` is withheld unless the address is actually PRIVATE. Well-formed
 *    IPv4 is not enough: on the single-box shape (the default shipping SKU)
 *    the LAN probe has no routing-summary WAN interface to read and falls back
 *    to the SAME device-bridge uplink-ip probe that supplies `wanAddress`, so
 *    on an edge_public box it returns the box's PUBLIC address. Emitting that
 *    would advertise a public address to clients labelled `lan` and duplicate
 *    `direct` — the exact redundancy `srflx` is withheld to avoid.
 *
 * And the same reasoning generalised: candidates colliding on host:port are
 * collapsed before returning, keeping the highest-priority kind. A second
 * candidate at an address already in the ladder tells the client nothing new
 * and costs it a wasted handshake.
 */
export function buildCandidates(input: CandidateInput): EndpointCandidate[] {
  const { placement, lanAddress, mapping, listenPort } = input;
  const out: EndpointCandidate[] = [];

  if (lanAddress && isPrivateIpv4(lanAddress)) {
    out.push({
      kind: "lan",
      host: lanAddress,
      port: listenPort,
      priority: PRIORITY.lan,
    });
  }

  if (placement.placement === "edge_public" && placement.publicIp) {
    out.push({
      kind: "direct",
      host: placement.publicIp,
      port: listenPort,
      priority: PRIORITY.direct,
    });
  }

  if (mapping) {
    out.push({
      kind: "mapped",
      host: mapping.host,
      port: mapping.port,
      priority: PRIORITY.mapped,
    });
  }

  const srflxUseful =
    placement.publicIp !== null &&
    placement.publicPort !== null &&
    placement.placement !== "edge_public" &&
    placement.placement !== "cgnat" &&
    placement.natClass !== "address_dependent";
  if (srflxUseful) {
    out.push({
      kind: "srflx",
      host: placement.publicIp as string,
      port: placement.publicPort as number,
      priority: PRIORITY.srflx,
    });
  }

  return dedupeByTransport(out.sort((a, b) => b.priority - a.priority));
}

/**
 * Collapse candidates that resolve to the same transport address, keeping the
 * highest-priority kind.
 *
 * Runs on the ALREADY-SORTED ladder, so first-seen is highest-priority by
 * construction rather than by relying on the order the pushes happen to be
 * written in. A stable `mapped` therefore survives over an identical `srflx`
 * observation, which is the right way round: one is a mapping the gateway
 * promised to hold, the other is a mapping we merely watched happen once.
 */
function dedupeByTransport(sorted: EndpointCandidate[]): EndpointCandidate[] {
  const seen = new Set<string>();
  return sorted.filter((c) => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * True when nothing in the ladder can plausibly carry a connection, so only a
 * blind relay (WARP-1390, not yet implemented) would help.
 *
 * This is what turns "the device sits at approved and silently never connects"
 * into something the owner can be told honestly.
 */
export function needsRelay(candidates: EndpointCandidate[]): boolean {
  return candidates.every((c) => c.kind === "lan" || c.kind === "relay");
}

/** The observations the box gathers about itself. Each is best-effort and
 *  independently failable — a probe that can't answer yields null and the
 *  classifier degrades to a weaker but honest conclusion. */
export interface PlacementProbes {
  /** The box's own WAN interface address. */
  wanAddress(): Promise<string | null>;
  /** STUN-reflexive mapping as `ip:port`. */
  stun(): Promise<string | null>;
  /** The box's LAN-facing address. */
  lanAddress(): Promise<string | null>;
  /** OPTIONAL second reflexive observation toward a DIFFERENT STUN
   *  destination. Without it NAT class stays `unknown`, which is deliberately
   *  permissive: we withhold `srflx` only on a POSITIVE address-dependent
   *  finding, never on absence of evidence. */
  stunAlt?(): Promise<string | null>;
}

export interface PlacementSnapshot {
  placement: PlacementResult;
  candidates: EndpointCandidate[];
  /** No remotely dial-able candidate — the owner should be told. */
  relayRequired: boolean;
}

/**
 * Observe, classify, and build the ladder — the whole auto-reconcile step.
 *
 * There is no cached placement to invalidate: every call re-observes, so a DHCP
 * renewal, a WAN failover, or the box being physically moved between an edge
 * WAN and someone else's subnet is picked up by the next caller with no
 * redeploy, no owner action, and nothing to reset.
 *
 * Every probe is individually best-effort. A failed probe must degrade the
 * conclusion, never throw — an unreachable device-bridge should cost a weaker
 * candidate list, not a failed profile fetch.
 */
export async function observePlacement(
  probes: PlacementProbes,
  opts: { listenPort: number; mapping?: PortMapping | null },
): Promise<PlacementSnapshot> {
  const safe = async (f: () => Promise<string | null>): Promise<string | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const [wanAddress, reflexive, lanAddress, reflexiveAlt] = await Promise.all([
    safe(() => probes.wanAddress()),
    safe(() => probes.stun()),
    safe(() => probes.lanAddress()),
    probes.stunAlt ? safe(() => probes.stunAlt!()) : Promise.resolve(null),
  ]);

  const placement = classifyPlacement({ wanAddress, reflexive, reflexiveAlt });
  const candidates = buildCandidates({
    placement,
    lanAddress,
    mapping: opts.mapping ?? null,
    listenPort: opts.listenPort,
  });
  return { placement, candidates, relayRequired: needsRelay(candidates) };
}
