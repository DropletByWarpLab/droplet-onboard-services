/**
 * Topology tree builder — the pure half of the Network → Overview topology
 * panel.
 *
 * The router reports no neighbour per jack and the switch reports no
 * port → device join yet, so most of what is pinned here is honesty: a cable
 * is attributed to a jack only when the evidence leaves one candidate, an
 * access point whose radios don't answer says so, and a port with no cable in
 * it draws nothing. Fixtures follow the live lab: an RB5009 edge router, a
 * Zyxel PoE switch, one Droplet access point.
 */
import { describe, it, expect } from "vitest";
import type { ApDeviceInfo, WirelessRadioSummary } from "@/lib/types";
import type { ApWirelessDetail } from "@/lib/api";
import type { RouterPort, RouterPortMap } from "@/lib/types/router-ports";
import type { SwitchPort, SwitchStatus } from "@/lib/types/switch";
import {
  buildTopology,
  describeApWifi,
  isTopologyAp,
  parseMbps,
  toApRadioRead,
  type TopologyInput,
  type TopologyNode,
} from "../topology-model";

// ── Fixtures ──────────────────────────────────────────────────────────

function jack(over: Partial<RouterPort> & { id: string }): RouterPort {
  return {
    role: "lan",
    networks: ["lan"],
    present: true,
    admin_up: true,
    link_up: false,
    speed: null,
    duplex: null,
    mac: null,
    is_sfp: false,
    traffic: null,
    status: "offline",
    disable_guard: null,
    ...over,
  };
}

const up = (id: string, speed: string, over: Partial<RouterPort> = {}) =>
  jack({ id, link_up: true, speed, status: "online", ...over });

const WAN = up("p1", "2.5 Gb", { role: "wan", networks: ["wan"] });

/** p1 is the WAN; `lan` are the LAN jacks that have a cable, the rest of p2–p8 are empty. */
function routerMap(lan: RouterPort[], over: Partial<RouterPortMap> = {}): RouterPortMap {
  const used = new Set(lan.map((p) => p.id));
  const empty = ["p2", "p3", "p4", "p5", "p6", "p7", "p8"]
    .filter((id) => !used.has(id))
    .map((id) => jack({ id }));
  return {
    supported: true,
    detail: null,
    model: "MikroTik RB5009",
    ports: [WAN, ...lan, ...empty],
    ...over,
  };
}

function swPort(over: Partial<SwitchPort> & { port: number }): SwitchPort {
  return {
    label: `1/${over.port}`,
    name: null,
    role: "unknown",
    link_up: false,
    speed: null,
    is_sfp: false,
    vlan: 1,
    vlan_name: "LAN",
    poe: null,
    status: "offline",
    ...over,
  };
}

const live = (port: number, role: SwitchPort["role"], over: Partial<SwitchPort> = {}) =>
  swPort({ port, role, link_up: true, speed: "1 Gb", status: "online", ...over });

const poe = (power_w: number) => ({ delivering: true, power_w, class: 4, max_power_w: 30 });

const SWITCH_STATUS: SwitchStatus = {
  connected: true,
  model: "Zyxel GS1900-10HP",
  firmware: "v2.80",
  auto_managed: true,
  vlan_profile: "flat-lan",
  last_provisioned_at: null,
  protected_port: 1,
  poe_budget_w: 77,
  poe_used_w: 19.7,
  poe_ports_active: 3,
};

/** Uplink on 1, the AP on 2, cameras on 3–4, a computer on 5, an unlabelled device on 6. */
function lanSwitch(over: Partial<SwitchPort>[] = []): TopologyInput["switch"] {
  const base = [
    live(1, "uplink"),
    live(2, "ap", { poe: poe(6.2) }),
    live(3, "camera", { poe: poe(4) }),
    live(4, "camera", { poe: poe(4.5) }),
    live(5, "client"),
    live(6, "unknown"),
    swPort({ port: 7, role: "camera" }), // configured as a camera, nothing plugged in
    swPort({ port: 8, role: "camera" }),
  ];
  return {
    status: SWITCH_STATUS,
    ports: base.map((p) => ({ ...p, ...(over.find((o) => o.port === p.port) ?? {}) })),
  };
}

function ap(over: Partial<ApDeviceInfo> = {}): ApDeviceInfo {
  return {
    mac: "80:ea:0b:39:ae:23",
    displayName: "Office AP",
    model: "NWA50BE",
    serial: null,
    version: null,
    lastIp: "192.168.9.20",
    hostname: null,
    status: "ONLINE",
    backend: "DROPLET_IMAGE",
    vendor: null,
    failureReason: null,
    approvedSsid: null,
    firstSeen: "2026-08-01T10:00:00Z",
    lastSeen: "2026-10-09T10:00:00Z",
    approvedAt: null,
    approvedBy: null,
    decommissionedAt: null,
    lastOperationId: null,
    ...over,
  };
}

function input(over: Partial<TopologyInput> = {}): TopologyInput {
  return {
    router: routerMap([up("p2", "1 Gb")]),
    switch: lanSwitch(),
    aps: [ap()],
    ...over,
  };
}

function flat(node: TopologyNode): TopologyNode[] {
  return [node, ...node.children.flatMap(flat)];
}
const byId = (root: TopologyNode, id: string) => flat(root).find((n) => n.id === id);
const routerOf = (i: TopologyInput) => buildTopology(i).root.children[0];

// ── The tree ──────────────────────────────────────────────────────────

describe("buildTopology — Internet → router → switch", () => {
  it("draws the chain, with the switch on the one jack that has a cable", () => {
    const { root } = buildTopology(input());

    expect(root).toMatchObject({ kind: "internet", name: "Internet", status: "2.5 Gb · p1", tone: "ok" });
    const [router] = root.children;
    expect(router).toMatchObject({ kind: "router", name: "MikroTik RB5009", status: "2 of 8 ports connected" });
    // The router's only cable is the switch's.
    expect(router.children).toHaveLength(1);
    expect(router.children[0]).toMatchObject({
      kind: "switch",
      name: "Zyxel GS1900-10HP",
      status: "6 of 8 ports in use",
      meta: "router p2 ↔ port 1 · 1 Gb",
    });
  });

  it("hangs the access point, cameras and other cables off the switch, in that order", () => {
    const sw = routerOf(input()).children[0];

    expect(sw.children.map((n) => [n.kind, n.name, n.status, n.meta])).toEqual([
      ["access-point", "Office AP", "Online", "port 2 · PoE 6.2 W"],
      ["camera", "Camera", "PoE 4.0 W", "port 3 · PoE 4.0 W"],
      ["camera", "Camera", "PoE 4.5 W", "port 4 · PoE 4.5 W"],
      ["computer", "Wired device", "1 Gb", "port 5 · 1 Gb"],
      ["device", "Wired device", "1 Gb", "port 6 · 1 Gb"],
    ]);
  });

  it("draws neither the uplink nor a jack with no cable as a device", () => {
    const ids = flat(buildTopology(input()).root).map((n) => n.id);

    expect(ids).not.toContain("switch-port-1"); // the uplink is the link to the router
    expect(ids).not.toContain("switch-port-7"); // camera-role, but empty: nothing is there
    expect(ids).not.toContain("switch-port-8");
  });

  it("finds the uplink by protected_port when the role isn't set", () => {
    const sw = lanSwitch([{ port: 1, role: "unknown" }])!;
    const router = routerOf(input({ switch: sw }));

    expect(flat(router).map((n) => n.id)).not.toContain("switch-port-1");
    expect(router.children[0].meta).toBe("router p2 ↔ port 1 · 1 Gb");
  });

  it("says so when the switch reports no ports", () => {
    const sw = routerOf(input({ switch: { status: SWITCH_STATUS, ports: [] }, aps: [] })).children[0];

    expect(sw).toMatchObject({ kind: "switch", status: "No ports reported", tone: "neutral", children: [] });
  });

  it("falls back to plain names when the boards report no model", () => {
    const i = input({
      router: routerMap([up("p2", "1 Gb")], { model: null }),
      switch: { status: { ...SWITCH_STATUS, model: "" }, ports: lanSwitch()!.ports },
    });
    const router = routerOf(i);

    expect(router.name).toBe("Router");
    expect(router.children[0].name).toBe("Switch");
  });

  it("uses a device's own name when the switch reports one, not the role label", () => {
    const sw = lanSwitch([
      { port: 3, name: "Garage cam" },
      { port: 4, name: "Camera" }, // the provisioner's role label, not a name
      { port: 5, device: { mac: "aa:bb:cc:dd:ee:01", name: "Front desk PC" } },
    ])!;
    const names = routerOf(input({ switch: sw })).children[0].children.map((n) => n.name);

    expect(names).toEqual(["Office AP", "Garage cam", "Camera", "Front desk PC", "Wired device"]);
  });
});

describe("buildTopology — which router jack carries the switch", () => {
  it("won't pick between two jacks that tie on speed, and names the candidates", () => {
    const router = routerOf(input({ router: routerMap([up("p2", "1 Gb"), up("p3", "1 Gb")]) }));

    expect(router.children).toHaveLength(2);
    const [sw, other] = router.children;
    // No jack claimed: the meta stays the switch's own side of the cable.
    expect(sw).toMatchObject({ kind: "switch", meta: "uplink port 1 · 1 Gb" });
    expect(other).toMatchObject({ kind: "device", name: "Wired device", meta: "router p2 or p3" });
  });

  it("uses the cable's speed to settle it, and the other cable is a device on the router", () => {
    const router = routerOf(
      input({
        router: routerMap([up("p2", "1 Gb"), up("p3", "2.5 Gb")]),
        switch: lanSwitch([{ port: 1, speed: "2.5 Gb" }]),
      }),
    );

    expect(router.children.map((n) => [n.kind, n.meta])).toEqual([
      ["switch", "router p3 ↔ port 1 · 2.5 Gb"],
      ["device", "router p2"],
    ]);
    expect(router.children[1]).toMatchObject({ name: "Wired device", status: "1 Gb", tone: "ok" });
  });

  it("reads the switch's 2500 Mb and the router's 2.5 Gb as the same speed", () => {
    const router = routerOf(
      input({
        router: routerMap([up("p2", "1 Gb"), up("p3", "2.5 Gb")]),
        switch: lanSwitch([{ port: 1, speed: "2500 Mb" }]),
      }),
    );

    expect(router.children[0].meta).toContain("router p3");
  });

  it("won't claim a jack whose speed contradicts the uplink's", () => {
    const router = routerOf(
      input({
        router: routerMap([up("p2", "100 Mb")]),
        switch: lanSwitch([{ port: 1, speed: "1 Gb" }]),
      }),
    );

    // One cable on the router, and it isn't the switch's — nothing to pool either.
    expect(router.children).toHaveLength(1);
    expect(router.children[0]).toMatchObject({ kind: "switch", meta: "uplink port 1 · 1 Gb" });
  });

  it("counts a guest-network jack as a cable like any other", () => {
    const router = routerOf(
      input({
        router: routerMap([up("p2", "1 Gb"), up("p3", "2.5 Gb", { role: "guest" })]),
        switch: lanSwitch([{ port: 1, speed: "2.5 Gb" }]),
      }),
    );

    expect(router.children.map((n) => n.meta)).toEqual(["router p3 ↔ port 1 · 2.5 Gb", "router p2"]);
  });
});

describe("buildTopology — no managed switch", () => {
  it("draws router → devices only, one per cable", () => {
    const router = routerOf(
      input({ router: routerMap([up("p2", "1 Gb"), up("p3", "100 Mb")]), switch: null, aps: [] }),
    );

    expect(router.children.map((n) => [n.id, n.kind, n.status, n.meta])).toEqual([
      ["router-p2", "device", "1 Gb", "router p2"],
      ["router-p3", "device", "100 Mb", "router p3"],
    ]);
  });

  it("hangs a coverage AP off the router, and keeps the other cable as a device", () => {
    const router = routerOf(
      input({ router: routerMap([up("p2", "1 Gb"), up("p3", "1 Gb")]), switch: null }),
    );

    // Two cables, one of them the AP's, and the router can't say which.
    expect(router.children.map((n) => [n.kind, n.meta])).toEqual([
      ["access-point", "port not identified"],
      ["device", "router p2 or p3"],
    ]);
  });

  it("puts the AP on the jack when it's the router's only cable", () => {
    const router = routerOf(input({ router: routerMap([up("p2", "1 Gb")]), switch: null }));

    expect(router.children).toHaveLength(1);
    expect(router.children[0]).toMatchObject({ kind: "access-point", meta: "router p2" });
  });

  it("shows only the router when nothing is plugged into it", () => {
    const router = routerOf(input({ router: routerMap([]), switch: null, aps: [] }));

    expect(router.children).toEqual([]);
    expect(router.status).toBe("1 of 8 ports connected");
  });
});

describe("buildTopology — the Internet end", () => {
  it("reads 'Upstream router' first when this Droplet router sits behind another", () => {
    const { root } = buildTopology(input({ posture: "DOWNSTREAM_ROUTER" }));

    expect(root).toMatchObject({ kind: "upstream", name: "Upstream router", meta: "your existing router" });
    expect(root.children[0]).toMatchObject({ kind: "router", name: "MikroTik RB5009" });
  });

  it("is still the Internet for a primary router, and when the posture isn't known", () => {
    expect(buildTopology(input({ posture: "PRIMARY_ROUTER" })).root.kind).toBe("internet");
    expect(buildTopology(input({ posture: "UNKNOWN" })).root.kind).toBe("internet");
    expect(buildTopology(input({ posture: null })).root.kind).toBe("internet");
  });

  it("says 'no cable' for an unplugged WAN jack, in grey rather than a fault colour", () => {
    const router = routerMap([up("p2", "1 Gb")]);
    router.ports[0] = jack({ id: "p1", role: "wan", networks: ["wan"] });

    expect(buildTopology(input({ router })).root).toMatchObject({ status: "no cable", tone: "neutral" });
  });

  it("flags a WAN jack an operator turned off", () => {
    const router = routerMap([up("p2", "1 Gb")]);
    router.ports[0] = jack({ id: "p1", role: "wan", status: "disabled" });

    expect(buildTopology(input({ router })).root).toMatchObject({ status: "turned off", tone: "err" });
  });

  it("claims nothing about the connection when the router lists no WAN jack", () => {
    const router = routerMap([up("p2", "1 Gb")]);
    router.ports = router.ports.filter((p) => p.role !== "wan");

    expect(buildTopology(input({ router })).root).toMatchObject({ name: "Internet", status: "" });
  });
});

// ── Access points ─────────────────────────────────────────────────────

describe("buildTopology — access points", () => {
  it("only draws APs that are on the LAN", () => {
    const aps = [
      ap({ mac: "00:00:00:00:00:01", status: "DISCOVERED" }),
      ap({ mac: "00:00:00:00:00:02", status: "DECOMMISSIONED" }),
      ap({ mac: "00:00:00:00:00:03", status: "AWAITING_APPROVAL", displayName: null, model: null }),
    ];
    expect(aps.map(isTopologyAp)).toEqual([false, false, true]);

    const drawn = flat(buildTopology(input({ aps, switch: lanSwitch([{ port: 2, role: "unknown" }]) })).root)
      .filter((n) => n.kind === "access-point");
    expect(drawn.map((n) => [n.name, n.status, n.tone])).toEqual([
      ["Access point", "Waiting for approval", "warn"],
    ]);
  });

  it("names what a not-yet-healthy AP is doing", () => {
    const sw = lanSwitch([{ port: 2, role: "unknown" }]);
    const status = (s: ApDeviceInfo["status"]) =>
      flat(buildTopology(input({ aps: [ap({ status: s })], switch: sw })).root).find(
        (n) => n.kind === "access-point",
      );

    expect(status("PROVISIONING")).toMatchObject({ status: "Setting up…", tone: "neutral" });
    expect(status("FAILED")).toMatchObject({ status: "Needs attention", tone: "err" });
  });

  it("flags only an ONLINE Droplet-image AP as one whose radios can be read", () => {
    const sw = lanSwitch();
    const node = (a: ApDeviceInfo) =>
      flat(buildTopology(input({ aps: [a], switch: sw })).root).find((n) => n.kind === "access-point")!;

    expect(node(ap()).ap).toEqual({ mac: "80:ea:0b:39:ae:23", readable: true });
    expect(node(ap({ backend: "UNIFI" })).ap?.readable).toBe(false);
    expect(node(ap({ status: "PROVISIONING" })).ap?.readable).toBe(false);
    // A third-party AP is simply online; we have no radios to read.
    expect(node(ap({ backend: "EASYMESH" }))).toMatchObject({ status: "Online", tone: "ok" });
  });

  it("pairs an AP row with the switch's own record of the device on the jack", () => {
    const sw = lanSwitch([
      { port: 2, role: "ap", device: { mac: "00:00:00:00:00:b2", name: null } },
      { port: 5, role: "ap", link_up: true, device: { mac: "00:00:00:00:00:a1", name: null } },
    ])!;
    const aps = [
      ap({ mac: "00:00:00:00:00:A1", displayName: "Lobby AP" }),
      ap({ mac: "00:00:00:00:00:B2", displayName: "Warehouse AP" }),
    ];
    const nodes = routerOf(input({ aps, switch: sw })).children[0].children.filter(
      (n) => n.kind === "access-point",
    );

    // Matched by MAC (case and separators ignored), not by the order of the rows.
    expect(nodes.map((n) => [n.name, n.meta])).toEqual([
      ["Warehouse AP", "port 2 · PoE 6.2 W"],
      ["Lobby AP", "port 5 · 1 Gb"],
    ]);
  });

  it("won't guess which of two APs is on which jack when the switch can't say", () => {
    const sw = lanSwitch([{ port: 5, role: "ap" }])!;
    const aps = [ap({ mac: "00:00:00:00:00:a1", displayName: "Lobby AP" }), ap({ displayName: "Warehouse AP" })];
    const nodes = routerOf(input({ aps, switch: sw })).children[0].children.filter(
      (n) => n.kind === "access-point",
    );

    // Both are drawn under the switch, neither on a jack, and the two cabled
    // AP jacks aren't drawn a second time as anonymous APs.
    expect(nodes.map((n) => [n.name, n.meta])).toEqual([
      ["Lobby AP", "port not identified"],
      ["Warehouse AP", "port not identified"],
    ]);
  });

  it("draws an AP-role jack that has a cable but no AP record as an AP we know nothing else about", () => {
    const nodes = flat(buildTopology(input({ aps: [] })).root).filter((n) => n.kind === "access-point");

    expect(nodes).toEqual([
      expect.objectContaining({
        name: "Access point",
        status: "Wi-Fi details unavailable",
        tone: "neutral",
        meta: "port 2 · PoE 6.2 W",
      }),
    ]);
    expect(nodes[0].ap).toBeUndefined();
  });

  it("hangs an AP with no AP-role jack off the switch, port not identified", () => {
    const sw = lanSwitch([{ port: 2, role: "unknown" }]);
    const nodes = routerOf(input({ switch: sw })).children[0].children;

    expect(nodes[0]).toMatchObject({ kind: "access-point", name: "Office AP", meta: "port not identified" });
  });
});

describe("buildTopology — an AP whose radios aren't reporting", () => {
  const rollup = (over: Partial<WirelessRadioSummary>): WirelessRadioSummary => ({
    router: 0,
    ap: 0,
    total: 0,
    active: 0,
    apsNotReporting: 0,
    ...over,
  });
  const apNode = (i: TopologyInput) =>
    flat(buildTopology(i).root).find((n) => n.kind === "access-point")!;

  it("says so, in warn, when the fabric rollup says every readable AP is silent", () => {
    // The shape behind the Wi-Fi tile's "Unknown — your access point isn't
    // reporting its radios".
    const node = apNode(input({ radios: rollup({ apsNotReporting: 1 }) }));

    expect(node).toMatchObject({ status: "Radios not reporting", tone: "warn" });
    // Still drawn, still wired to its jack: silent radios don't unplug it.
    expect(node.meta).toBe("port 2 · PoE 6.2 W");
  });

  it("makes no claim about the radios when the rollup is healthy or absent", () => {
    expect(apNode(input({ radios: rollup({ ap: 2, total: 2, active: 2 }) })).status).toBe("Online");
    expect(apNode(input()).status).toBe("Online");
  });

  it("won't blame the AP when the silent one is a different AP", () => {
    // Two readable APs, one silent: from the rollup alone we can't say which.
    const node = apNode(
      input({
        aps: [ap(), ap({ mac: "00:00:00:00:00:02", displayName: "Second AP" })],
        radios: rollup({ apsNotReporting: 1 }),
      }),
    );

    expect(node.status).toBe("Online");
  });
});

// ── The AP's Wi-Fi line ───────────────────────────────────────────────

const detail = (over: Partial<ApWirelessDetail> = {}): ApWirelessDetail => ({
  mac: "80:ea:0b:39:ae:23",
  supported: true,
  radios: [
    {
      section: "radio0",
      radio: "radio0",
      band: "2g",
      ssid: "Office",
      encryption: "psk2",
      channel: "auto",
      htmode: "HE20",
      disabled: false,
      primary: true,
      ifname: "phy0-ap0",
      up: true,
      live_channel: 6,
      live_htmode: "HE20",
      clients: 11,
    },
    {
      section: "radio1",
      radio: "radio1",
      band: "5g",
      ssid: "Office-5g",
      encryption: "psk2",
      channel: "auto",
      htmode: "HE80",
      disabled: false,
      primary: false,
      ifname: "phy1-ap0",
      up: true,
      live_channel: 36,
      live_htmode: "HE80",
      clients: 15,
    },
  ],
  ...over,
});

describe("toApRadioRead", () => {
  const read = (over: Partial<Parameters<typeof toApRadioRead>[0]> = {}) =>
    toApRadioRead({ enabled: true, detail: detail(), failed: false, ...over });

  it("sums the clients across the AP's radios", () => {
    expect(read()).toEqual({ state: "reporting", radios: 2, onAir: 2, clients: 26 });
  });

  it("leaves the count unknown, not zero, when no radio reports one", () => {
    const radios = detail().radios.map((r) => ({ ...r, clients: null }));

    expect(read({ detail: detail({ radios }) })).toMatchObject({ state: "reporting", clients: null });
  });

  it("counts a radio as on the air unless it is disabled or down", () => {
    const [a, b] = detail().radios;

    expect(read({ detail: detail({ radios: [a, { ...b, disabled: true }] }) })).toMatchObject({ onAir: 1 });
    expect(read({ detail: detail({ radios: [a, { ...b, up: false }] }) })).toMatchObject({ onAir: 1 });
    // `up` is null on an image that doesn't report link state — not "off".
    expect(read({ detail: detail({ radios: [a, { ...b, up: null }] }) })).toMatchObject({ onAir: 2 });
  });

  it("reads a viewer who can't see per-AP radios as restricted, whatever else is true", () => {
    expect(read({ enabled: false, detail: undefined })).toEqual({ state: "restricted" });
    expect(read({ enabled: false, failed: true })).toEqual({ state: "restricted" });
  });

  it("is pending until the read lands", () => {
    expect(read({ detail: undefined })).toEqual({ state: "pending" });
  });

  it("is not reporting when the AP says it has no wireless state, or the read fails", () => {
    expect(read({ detail: detail({ supported: false, radios: [] }) })).toEqual({ state: "not-reporting" });
    expect(read({ detail: undefined, failed: true })).toEqual({ state: "not-reporting" });
  });

  it("lets a failed read beat the stale numbers SWR keeps", () => {
    expect(read({ failed: true })).toEqual({ state: "not-reporting" });
  });
});

describe("describeApWifi", () => {
  const quiet = { allSilent: false };
  const reporting = (clients: number | null, radios = 2, onAir = radios) =>
    describeApWifi({ state: "reporting", radios, onAir, clients }, quiet);

  it("leads with the wireless client count", () => {
    expect(reporting(26)).toEqual({ status: "26 clients", tone: "ok" });
    expect(reporting(1).status).toBe("1 client");
    expect(reporting(0)).toEqual({ status: "No clients", tone: "ok" });
  });

  it("says radios aren't reporting rather than showing a number it doesn't have", () => {
    expect(describeApWifi({ state: "not-reporting" }, quiet)).toEqual({
      status: "Radios not reporting",
      tone: "warn",
    });
  });

  it("falls back to the rollup for a viewer who can't read the radios", () => {
    expect(describeApWifi({ state: "restricted" }, { allSilent: true })).toEqual({
      status: "Radios not reporting",
      tone: "warn",
    });
    expect(describeApWifi({ state: "restricted" }, quiet)).toEqual({ status: "Online", tone: "ok" });
  });

  it("doesn't call a read in flight an outage", () => {
    expect(describeApWifi({ state: "pending" }, { allSilent: true })).toEqual({
      status: "Checking radios…",
      tone: "neutral",
    });
  });

  it("says how many radios are up when some are down", () => {
    expect(reporting(26, 2, 1)).toEqual({ status: "26 clients · 1 of 2 radios on", tone: "warn" });
    expect(reporting(null, 2, 1)).toEqual({ status: "1 of 2 radios on the air", tone: "warn" });
    expect(reporting(null, 2, 2)).toEqual({ status: "2 radios on the air", tone: "ok" });
    expect(reporting(null, 1, 1).status).toBe("1 radio on the air");
  });

  it("names the degenerate cases instead of a count", () => {
    expect(reporting(0, 0, 0)).toEqual({ status: "No radios found", tone: "warn" });
    expect(reporting(0, 2, 0)).toEqual({ status: "Radios are off", tone: "warn" });
  });
});

describe("parseMbps", () => {
  it("reads both boards' speed labels", () => {
    expect(parseMbps("2.5 Gb")).toBe(2500);
    expect(parseMbps("1 Gb")).toBe(1000);
    expect(parseMbps("10 Gb")).toBe(10000);
    expect(parseMbps("2500 Mb")).toBe(2500);
    expect(parseMbps("100 Mb")).toBe(100);
  });

  it("returns null for anything it can't read", () => {
    expect(parseMbps(null)).toBeNull();
    expect(parseMbps("")).toBeNull();
    expect(parseMbps("up")).toBeNull();
  });
});
