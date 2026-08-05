/**
 * WARP-1758 — WAN placement + endpoint candidates.
 *
 * The point of keeping the classifier pure is that every placement the fleet
 * can be in becomes a table row here, instead of something only reproducible by
 * physically moving a box between an edge WAN and someone else's subnet.
 */
import { describe, it, expect } from "vitest";
import {
  buildCandidates,
  classifyNat,
  classifyPlacement,
  isCgnatIpv4,
  isPrivateIpv4,
  isPublicIpv4,
  needsRelay,
  observePlacement,
  splitEndpoint,
  type PlacementResult,
} from "./overlay-placement.service.js";

describe("address classification", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.254", true],
    ["172.32.0.1", false], // just outside the /12 — a classic off-by-one
    ["172.15.255.255", false],
    ["192.168.1.1", true],
    ["192.169.1.1", false],
    ["127.0.0.1", true],
    ["169.254.1.1", true],
    ["203.0.113.7", false],
  ])("isPrivateIpv4(%s) === %s", (ip, expected) => {
    expect(isPrivateIpv4(ip as string)).toBe(expected);
  });

  it.each([
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["100.63.255.255", false], // below the /10
    ["100.128.0.1", false], // above the /10
    ["100.100.1.1", true],
    ["203.0.113.7", false],
  ])("isCgnatIpv4(%s) === %s", (ip, expected) => {
    expect(isCgnatIpv4(ip as string)).toBe(expected);
  });

  it.each([
    ["203.0.113.7", true],
    ["8.8.8.8", true],
    ["10.0.0.1", false],
    ["100.64.0.1", false], // CGNAT is not public for our purposes
    ["224.0.0.1", false], // multicast
    ["0.0.0.0", false],
    ["not-an-ip", false],
    ["999.1.1.1", false],
  ])("isPublicIpv4(%s) === %s", (ip, expected) => {
    expect(isPublicIpv4(ip as string)).toBe(expected);
  });

  it.each([
    ["203.0.113.7:51820", { ip: "203.0.113.7", port: 51820 }],
    ["203.0.113.7:1", { ip: "203.0.113.7", port: 1 }],
    ["203.0.113.7:0", null],
    ["203.0.113.7:65536", null],
    ["203.0.113.7", null],
    ["203.0.113.7:", null],
    ["notanip:51820", null],
    ["", null],
  ])("splitEndpoint(%s)", (input, expected) => {
    expect(splitEndpoint(input as string)).toEqual(expected);
  });
});

describe("classifyPlacement", () => {
  // The founder requirement, both halves.
  it("calls it edge_public when the box's WAN address IS its public address", () => {
    const r = classifyPlacement({
      wanAddress: "203.0.113.7",
      reflexive: "203.0.113.7:51820",
    });
    expect(r.placement).toBe("edge_public");
    expect(r.publicIp).toBe("203.0.113.7");
    expect(r.publicPort).toBe(51820);
  });

  it("calls it behind_nat when the box has a private WAN and a public reflexive", () => {
    const r = classifyPlacement({
      wanAddress: "192.168.1.50",
      reflexive: "203.0.113.7:41234",
    });
    expect(r.placement).toBe("behind_nat");
    expect(r.reason).toContain("192.168.1.50");
    expect(r.reason).toContain("203.0.113.7");
  });

  // Double NAT where the intermediate hop is itself public but not us.
  it("calls it behind_nat when a public WAN differs from the public address", () => {
    expect(
      classifyPlacement({
        wanAddress: "198.51.100.4",
        reflexive: "203.0.113.7:41234",
      }).placement,
    ).toBe("behind_nat");
  });

  it("calls it cgnat when the public-facing address is in 100.64.0.0/10", () => {
    const r = classifyPlacement({
      wanAddress: "192.168.1.50",
      reflexive: "100.100.7.7:41234",
    });
    expect(r.placement).toBe("cgnat");
    expect(r.reason).toMatch(/carrier-grade/i);
  });

  it("calls it cgnat when the box's OWN WAN address is CGNAT", () => {
    expect(
      classifyPlacement({
        wanAddress: "100.100.7.7",
        reflexive: "203.0.113.7:41234",
      }).placement,
    ).toBe("cgnat");
  });

  // Never guess. An honest unknown lets the caller fall back rather than
  // advertise an endpoint that may not work.
  it("is unknown with no STUN observation", () => {
    const r = classifyPlacement({ wanAddress: "203.0.113.7", reflexive: null });
    expect(r.placement).toBe("unknown");
    expect(r.publicIp).toBeNull();
  });

  it("is unknown when the WAN address is unavailable, even with a public reflexive", () => {
    const r = classifyPlacement({
      wanAddress: null,
      reflexive: "203.0.113.7:41234",
    });
    // Crucially NOT edge_public — a public reflexive alone does not prove we
    // are the edge, and claiming it would advertise a `direct` candidate that
    // nothing is listening on.
    expect(r.placement).toBe("unknown");
    expect(r.publicIp).toBe("203.0.113.7");
  });

  it("is unknown when the reflexive address is not routable", () => {
    expect(
      classifyPlacement({
        wanAddress: "192.168.1.50",
        reflexive: "192.168.1.50:51820",
      }).placement,
    ).toBe("unknown");
  });

  it("is unknown on a malformed reflexive observation", () => {
    expect(
      classifyPlacement({ wanAddress: "203.0.113.7", reflexive: "garbage" })
        .placement,
    ).toBe("unknown");
  });

  // Auto-reconcile: the same box classified again after its WAN changed must
  // land on the new answer, with no cached state to invalidate.
  it("re-classifies when the box moves from the edge into a subnet", () => {
    const asEdge = classifyPlacement({
      wanAddress: "203.0.113.7",
      reflexive: "203.0.113.7:51820",
    });
    const moved = classifyPlacement({
      wanAddress: "192.168.1.50",
      reflexive: "198.51.100.9:41234",
    });
    expect(asEdge.placement).toBe("edge_public");
    expect(moved.placement).toBe("behind_nat");
  });
});

describe("classifyNat", () => {
  it("is endpoint_independent when both observations agree", () => {
    expect(classifyNat("203.0.113.7:41234", "203.0.113.7:41234")).toBe(
      "endpoint_independent",
    );
  });

  it("is address_dependent when the port differs per destination", () => {
    expect(classifyNat("203.0.113.7:41234", "203.0.113.7:51999")).toBe(
      "address_dependent",
    );
  });

  it("is address_dependent when the address differs per destination", () => {
    expect(classifyNat("203.0.113.7:41234", "198.51.100.9:41234")).toBe(
      "address_dependent",
    );
  });

  it("is unknown with only one sample", () => {
    expect(classifyNat("203.0.113.7:41234", null)).toBe("unknown");
  });

  // The old heuristic (port === 51820 ⇒ punchable) is NOT reintroduced: a
  // port-preserving symmetric NAT passes it and a port-rewriting cone NAT
  // fails it, so it produced false answers in both directions.
  it("does not infer a class from a port-preserving single sample", () => {
    expect(classifyNat("203.0.113.7:51820", null)).toBe("unknown");
  });
});

describe("buildCandidates", () => {
  const placement = (over: Partial<PlacementResult> = {}): PlacementResult => ({
    placement: "behind_nat",
    natClass: "endpoint_independent",
    publicIp: "203.0.113.7",
    publicPort: 41234,
    reason: "",
    ...over,
  });

  it("offers the LAN candidate first — no HQ round trip when already home", () => {
    const c = buildCandidates({
      placement: placement(),
      lanAddress: "192.168.1.50",
      mapping: null,
      listenPort: 51820,
    });
    expect(c[0]).toEqual({
      kind: "lan",
      host: "192.168.1.50",
      port: 51820,
      priority: 120,
    });
  });

  it("offers a direct candidate on an edge_public box, using the WG listen port", () => {
    const c = buildCandidates({
      placement: placement({ placement: "edge_public", publicPort: 51820 }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([
      { kind: "direct", host: "203.0.113.7", port: 51820, priority: 100 },
    ]);
  });

  // Redundant with `direct` — a duplicate just costs a wasted handshake.
  it("does not also offer srflx on an edge_public box", () => {
    const c = buildCandidates({
      placement: placement({ placement: "edge_public" }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c.map((x) => x.kind)).toEqual(["direct"]);
  });

  it("offers srflx behind a NAT that maps consistently", () => {
    const c = buildCandidates({
      placement: placement(),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([
      { kind: "srflx", host: "203.0.113.7", port: 41234, priority: 60 },
    ]);
  });

  // The mapping STUN saw is per-destination, so it is NOT the mapping the
  // client would hit. Advertising it sends the client at an address that
  // cannot answer.
  it("withholds srflx under address_dependent NAT", () => {
    const c = buildCandidates({
      placement: placement({ natClass: "address_dependent" }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([]);
  });

  it("withholds srflx under CGNAT", () => {
    const c = buildCandidates({
      placement: placement({ placement: "cgnat" }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([]);
  });

  it("prefers a stable port mapping over the reflexive observation", () => {
    const c = buildCandidates({
      placement: placement(),
      lanAddress: null,
      mapping: { host: "203.0.113.7", port: 51820 },
      listenPort: 51820,
    });
    expect(c.map((x) => x.kind)).toEqual(["mapped", "srflx"]);
  });

  it("orders a full ladder LAN → direct → mapped → srflx", () => {
    const c = buildCandidates({
      placement: placement({ placement: "behind_nat" }),
      lanAddress: "192.168.1.50",
      mapping: { host: "203.0.113.7", port: 51820 },
      listenPort: 51820,
    });
    expect(c.map((x) => x.kind)).toEqual(["lan", "mapped", "srflx"]);
    expect(c.map((x) => x.priority)).toEqual([120, 80, 60]);
  });

  it("emits nothing when the box learned nothing about itself", () => {
    const c = buildCandidates({
      placement: classifyPlacement({ wanAddress: null, reflexive: null }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([]);
  });

  it("ignores a non-IPv4 LAN address rather than emitting a name", () => {
    const c = buildCandidates({
      placement: placement({ placement: "cgnat" }),
      lanAddress: "droplet.local",
      mapping: null,
      listenPort: 51820,
    });
    expect(c).toEqual([]);
  });

  // Still unknown-placement: we don't know we're the edge, but the reflexive
  // mapping is still worth trying.
  it("still offers srflx when placement is unknown but a mapping was observed", () => {
    const c = buildCandidates({
      placement: classifyPlacement({
        wanAddress: null,
        reflexive: "203.0.113.7:41234",
      }),
      lanAddress: null,
      mapping: null,
      listenPort: 51820,
    });
    expect(c.map((x) => x.kind)).toEqual(["srflx"]);
  });
});

describe("observePlacement", () => {
  const probes = (over: Partial<Record<string, () => Promise<string | null>>> = {}) => ({
    wanAddress: async () => "192.168.1.50",
    stun: async () => "203.0.113.7:41234",
    lanAddress: async () => "192.168.1.50",
    ...over,
  });

  it("observes, classifies, and builds the ladder in one pass", async () => {
    const s = await observePlacement(probes(), { listenPort: 51820 });
    expect(s.placement.placement).toBe("behind_nat");
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan", "srflx"]);
    expect(s.relayRequired).toBe(false);
  });

  it("detects the edge-router shape", async () => {
    const s = await observePlacement(
      probes({
        wanAddress: async () => "203.0.113.7",
        stun: async () => "203.0.113.7:51820",
        lanAddress: async () => "192.168.20.1",
      }),
      { listenPort: 51820 },
    );
    expect(s.placement.placement).toBe("edge_public");
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan", "direct"]);
  });

  // An unreachable device-bridge must cost a weaker candidate list, never a
  // failed profile fetch — the client can still try whatever survived.
  it("degrades instead of throwing when a probe rejects", async () => {
    const s = await observePlacement(
      probes({
        wanAddress: async () => {
          throw new Error("bridge unreachable");
        },
      }),
      { listenPort: 51820 },
    );
    expect(s.placement.placement).toBe("unknown");
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan", "srflx"]);
  });

  it("survives every probe failing at once", async () => {
    const boom = async () => {
      throw new Error("down");
    };
    const s = await observePlacement(
      { wanAddress: boom, stun: boom, lanAddress: boom },
      { listenPort: 51820 },
    );
    expect(s.placement.placement).toBe("unknown");
    expect(s.candidates).toEqual([]);
    expect(s.relayRequired).toBe(true);
  });

  // The CGNAT household: works at home, cannot work from anywhere else. The
  // owner has to be told, not left with a device stuck at "approved".
  it("flags relayRequired on a CGNAT box that only has a LAN path", async () => {
    const s = await observePlacement(
      probes({ stun: async () => "100.100.7.7:41234" }),
      { listenPort: 51820 },
    );
    expect(s.placement.placement).toBe("cgnat");
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan"]);
    expect(s.relayRequired).toBe(true);
  });

  it("uses a supplied port mapping as the preferred remote candidate", async () => {
    const s = await observePlacement(probes(), {
      listenPort: 51820,
      mapping: { host: "203.0.113.7", port: 51820 },
    });
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan", "mapped", "srflx"]);
  });

  // Re-observation is the whole auto-reconcile mechanism: no cached placement,
  // so the answer follows the network without anything to invalidate.
  it("follows the box from an edge WAN into a subnet with no state to reset", async () => {
    let atEdge = true;
    const p = {
      wanAddress: async () => (atEdge ? "203.0.113.7" : "192.168.1.50"),
      stun: async () => (atEdge ? "203.0.113.7:51820" : "198.51.100.9:41234"),
      lanAddress: async () => null,
    };
    expect((await observePlacement(p, { listenPort: 51820 })).placement.placement).toBe(
      "edge_public",
    );
    atEdge = false;
    const after = await observePlacement(p, { listenPort: 51820 });
    expect(after.placement.placement).toBe("behind_nat");
    expect(after.candidates[0]).toMatchObject({
      kind: "srflx",
      host: "198.51.100.9",
      port: 41234,
    });
  });

  it("uses a second STUN observation to withhold srflx under symmetric NAT", async () => {
    const s = await observePlacement(
      {
        ...probes(),
        stunAlt: async () => "203.0.113.7:59999",
      },
      { listenPort: 51820 },
    );
    expect(s.placement.natClass).toBe("address_dependent");
    expect(s.candidates.map((c) => c.kind)).toEqual(["lan"]);
    expect(s.relayRequired).toBe(true);
  });
});

describe("needsRelay", () => {
  it("is true when the ladder is empty (CGNAT, nothing dial-able)", () => {
    expect(needsRelay([])).toBe(true);
  });

  // A LAN-only ladder is precisely the "works at home, silently never connects
  // from anywhere else" case the owner has to be told about.
  it("is true when only a LAN candidate exists", () => {
    expect(
      needsRelay([
        { kind: "lan", host: "192.168.1.50", port: 51820, priority: 120 },
      ]),
    ).toBe(true);
  });

  it("is false once any remotely dial-able candidate exists", () => {
    expect(
      needsRelay([
        { kind: "lan", host: "192.168.1.50", port: 51820, priority: 120 },
        { kind: "srflx", host: "203.0.113.7", port: 41234, priority: 60 },
      ]),
    ).toBe(false);
  });
});
