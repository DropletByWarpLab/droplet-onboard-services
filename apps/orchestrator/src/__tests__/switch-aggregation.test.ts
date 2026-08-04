/**
 * §7 aggregation derivation (ADDON-network-switch-management.md §7).
 *
 * Pure-function unit tests for the join that turns the switch-service raw
 * reads into the dashboard §7 shapes: role (camera/ap/client/uplink/unknown),
 * status (online/warn/offline/blocked), vlan_profile, PoE mW→W, and the
 * status-level budget derivation. Fixtures mirror the recorded device payloads
 * (services/switch test fakes) — no live switch, no service.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateStatus,
  aggregatePorts,
  aggregateVlans,
  derivePortName,
} from "../services/switch-aggregation.service.js";
import type {
  SwitchProvisionConfig,
  SwitchRawPort,
  SwitchRawPortStatus,
  SwitchRawPoe,
} from "../types/switch.js";

// --- Fixtures (mirror the switch service's read shapes) --------------------

const SYSINFO = {
  model: "Zyxel GS1900-10HP A1",
  firmware_version: "v1.04.0079",
  mac_address: "00-C0-F2-A3-E6-3D",
  hostname: "Droplet Switch",
  port_count: 10,
  poe_budget_mw: null,
  driver: "openwrt",
};

// Two PoE rows: port 1 delivering 12.5 W; port 7 a fault (class negotiated but
// not delivering → warn). Ports 2-6, 8 not powered; 9-10 SFP (no PoE).
const POE: SwitchRawPoe[] = [
  { port: 1, enabled: true, delivering: true, power_mw: 12500, class: "Class 3", max_power_mw: 30000 },
  { port: 6, enabled: false, delivering: false, power_mw: 0, class: "", max_power_mw: 30000 },
  { port: 7, enabled: true, delivering: false, power_mw: 0, class: "Class 4", max_power_mw: 30000 },
  { port: 8, enabled: true, delivering: true, power_mw: 4100, class: "Class 4", max_power_mw: 30000 },
];

// vlan_port_stat: PVID per port (port 5 = trunk uplink on this fixture is
// handled by protected_port, not is_trunk, in the role derivation).
const RAW_PORTS: SwitchRawPort[] = Array.from({ length: 10 }, (_, i) => {
  const port = i + 1;
  return {
    port,
    name: `Port ${port}`,
    enabled: port !== 6, // port 6 administratively disabled → blocked
    link_up: false,
    speed: "",
    duplex: "",
    is_sfp: port >= 9,
    is_trunk: port === 9,
    vlan: 1,
  };
});

// port_status: the real link/speed. Ports 1,4,7,8 up @1Gb; 9 up @10Gb (uplink);
// the rest down.
const PORT_STATUS: SwitchRawPortStatus[] = [
  { port: 1, link_up: true, speed: "1 Gb", is_sfp: false },
  { port: 2, link_up: false, speed: "", is_sfp: false },
  { port: 3, link_up: false, speed: "", is_sfp: false },
  { port: 4, link_up: true, speed: "1 Gb", is_sfp: false },
  { port: 5, link_up: false, speed: "", is_sfp: false },
  { port: 6, link_up: false, speed: "", is_sfp: false },
  { port: 7, link_up: true, speed: "1 Gb", is_sfp: false },
  { port: 8, link_up: true, speed: "1 Gb", is_sfp: false },
  { port: 9, link_up: true, speed: "10 Gb", is_sfp: true },
  { port: 10, link_up: false, speed: "", is_sfp: false },
];

const VLANS = [
  { vlan_id: 1, name: "LAN", ports: [{ port: 1, tagged: false, member: true }, { port: 4, tagged: false, member: true }] },
  { vlan_id: 100, name: "cameras", ports: [{ port: 7, tagged: false, member: true }, { port: 8, tagged: false, member: true }, { port: 9, tagged: true, member: true }] },
];

function makeConfig(over: Partial<SwitchProvisionConfig> = {}): SwitchProvisionConfig {
  return {
    vlan_profile: "flat-lan",
    auto_managed: true,
    protected_port: 9,
    camera_ports: [7, 8],
    ap_ports: [2, 4],
    client_ports: [1, 3],
    poe_budget_w: 130,
    last_provisioned_at: "2026-06-03T23:40:00Z",
    ...over,
  };
}

// --- Status ----------------------------------------------------------------

describe("aggregateStatus", () => {
  it("joins system-info + poe + provision-config into the §7 status shape", () => {
    const s = aggregateStatus({ connected: true, systemInfo: SYSINFO, poe: POE, config: makeConfig() });

    expect(s.connected).toBe(true);
    expect(s.model).toBe("Zyxel GS1900-10HP A1");
    expect(s.firmware).toBe("v1.04.0079");
    expect(s.auto_managed).toBe(true);
    expect(s.vlan_profile).toBe("flat-lan");
    expect(s.last_provisioned_at).toBe("2026-06-03T23:40:00Z");
    expect(s.protected_port).toBe(9);
    expect(s.poe_budget_w).toBe(130);
  });

  it("sums delivering PoE in watts (mW→W) and counts powered ports", () => {
    const s = aggregateStatus({ connected: true, systemInfo: SYSINFO, poe: POE, config: makeConfig() });
    // delivering: port 1 (12500 mW) + port 8 (4100 mW) = 16.6 W. Port 7 is a
    // fault (not delivering) → excluded from used + active.
    expect(s.poe_used_w).toBeCloseTo(16.6, 5);
    expect(s.poe_ports_active).toBe(2);
  });

  it("reports a disconnected switch without fabricating model/firmware", () => {
    const s = aggregateStatus({ connected: false, systemInfo: null, poe: [], config: makeConfig() });
    expect(s.connected).toBe(false);
    expect(s.model).toBeNull();
    expect(s.firmware).toBeNull();
    // Config-derived header fields still come through (the service answers
    // provision-config even when the switch is absent).
    expect(s.vlan_profile).toBe("flat-lan");
    expect(s.poe_budget_w).toBe(130);
    expect(s.poe_used_w).toBe(0);
    expect(s.poe_ports_active).toBe(0);
  });

  it("coerces an unknown vlan_profile to flat-lan (camera-safe default)", () => {
    const s = aggregateStatus({
      connected: true, systemInfo: SYSINFO, poe: [],
      config: makeConfig({ vlan_profile: "weird" }),
    });
    expect(s.vlan_profile).toBe("flat-lan");
  });
});

// --- Ports -----------------------------------------------------------------

describe("aggregatePorts", () => {
  const ports = () =>
    aggregatePorts({
      rawPorts: RAW_PORTS,
      portStatus: PORT_STATUS,
      poe: POE,
      vlans: VLANS,
      config: makeConfig(),
    });

  it("fills link_up/speed from port_status, not vlan_port_stat", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[1].link_up).toBe(true);
    expect(byPort[1].speed).toBe("1 Gb");
    expect(byPort[2].link_up).toBe(false);
    expect(byPort[2].speed).toBeNull(); // "" → null on the §7 contract
    expect(byPort[9].speed).toBe("10 Gb");
  });

  it("labels ports '1/N' and flags SFP by position", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[4].label).toBe("1/4");
    expect(byPort[9].label).toBe("1/9");
    expect(byPort[9].is_sfp).toBe(true);
    expect(byPort[1].is_sfp).toBe(false);
  });

  it("derives role: camera/ap/client → role; protected_port → uplink; else unknown", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[7].role).toBe("camera"); // camera_ports [7,8]
    expect(byPort[8].role).toBe("camera");
    expect(byPort[2].role).toBe("ap"); // ap_ports [2,4]
    expect(byPort[4].role).toBe("ap");
    expect(byPort[1].role).toBe("client"); // client_ports [1,3]
    expect(byPort[3].role).toBe("client");
    expect(byPort[9].role).toBe("uplink"); // protected_port 9
    expect(byPort[5].role).toBe("unknown"); // unspecified
    expect(byPort[10].role).toBe("unknown");
  });

  it("derives status: blocked(disabled) > offline(down) > warn(PoE fault) > online", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    // Port 6: administratively disabled → blocked (takes precedence over down).
    expect(byPort[6].status).toBe("blocked");
    // Port 2: enabled, link down → offline.
    expect(byPort[2].status).toBe("offline");
    // Port 7: enabled, link up, PoE class negotiated but not delivering → warn.
    expect(byPort[7].status).toBe("warn");
    // Port 1: enabled, up, PoE delivering cleanly → online.
    expect(byPort[1].status).toBe("online");
    // Port 9: enabled, up, no PoE (SFP) → online.
    expect(byPort[9].status).toBe("online");
  });

  it("maps PoE to watts on copper ports; SFP and unpowered ports get poe null", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[1].poe).toEqual({
      delivering: true,
      power_w: 12.5,
      class: 3, // "Class 3" → 3
      max_power_w: 30,
    });
    // Port 7 fault: class parsed, not delivering, 0 W.
    expect(byPort[7].poe).toEqual({ delivering: false, power_w: 0, class: 4, max_power_w: 30 });
    // SFP port 9: no PoE row → null.
    expect(byPort[9].poe).toBeNull();
    // Port 3: copper but no PoE row → null (not all copper ports are powered).
    expect(byPort[3].poe).toBeNull();
  });

  it("joins vlan + vlan_name from membership", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    // Port 7 is an untagged member of VLAN 100 (cameras) per membership.
    expect(byPort[7].vlan).toBe(100);
    expect(byPort[7].vlan_name).toBe("cameras");
    // Port 1 untagged on VLAN 1 (LAN).
    expect(byPort[1].vlan).toBe(1);
    expect(byPort[1].vlan_name).toBe("LAN");
    // The MAC→device join still has no ACL-legal source on the flashed image
    // (WARP-1717), so `device` stays null — but `name` no longer does.
    expect(byPort[1].device).toBeNull();
  });

  // WARP-1716: `name` used to be a hardcoded null, which the dashboard rendered
  // as the word "Open" — on every port, including ones with link up and traffic
  // flowing. A provisioned role is a name we can state honestly.
  it("names a port from its provisioned role", () => {
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[1].name).toBe("Client"); // client_ports [1,3]
    expect(byPort[2].name).toBe("Access point"); // ap_ports [2,4]
    expect(byPort[7].name).toBe("Camera"); // camera_ports [7,8]
    expect(byPort[9].name).toBe("Uplink"); // protected_port 9
  });

  it("leaves an unprovisioned port unnamed rather than labelling it 'Port N'", () => {
    // The openwrt driver labels every port "Port N", which says nothing the
    // `1/N` label doesn't. Passing it through would just be noise dressed up as
    // an answer; null lets the dashboard describe the port by link state.
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[5].role).toBe("unknown");
    expect(byPort[5].name).toBeNull();
  });

  it("returns all 10 ports sorted", () => {
    const ps = ports();
    expect(ps.map((p) => p.port)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // WARP-1716: without counters the dashboard can't tell a busy port from one
  // that's merely plugged in — which is exactly the report that opened the bug
  // ("says open even though there is traffic running through the ports").
  it("carries per-port byte counters through from port_status", () => {
    const withTraffic = aggregatePorts({
      rawPorts: RAW_PORTS,
      portStatus: PORT_STATUS.map((s) =>
        s.port === 1 ? { ...s, traffic: { rx_bytes: 1_500_000, tx_bytes: 900_000 } } : s,
      ),
      poe: POE,
      vlans: VLANS,
      config: makeConfig(),
    });
    const byPort = Object.fromEntries(withTraffic.map((p) => [p.port, p]));
    expect(byPort[1].traffic).toEqual({ rx_bytes: 1_500_000, tx_bytes: 900_000 });
  });

  it("reports traffic as null — never zero — when the driver has no counters", () => {
    // "We don't know" and "nothing crossed this port" are different claims.
    const byPort = Object.fromEntries(ports().map((p) => [p.port, p]));
    expect(byPort[1].traffic).toBeNull();
  });

  it("rejects nonsensical counters rather than rendering them", () => {
    const bogus = aggregatePorts({
      rawPorts: RAW_PORTS,
      portStatus: [
        { port: 1, link_up: true, speed: "1 Gb", is_sfp: false, traffic: { rx_bytes: -1, tx_bytes: 5 } },
        { port: 2, link_up: true, speed: "1 Gb", is_sfp: false, traffic: { rx_bytes: NaN, tx_bytes: 5 } },
      ],
      poe: [],
      vlans: VLANS,
      config: makeConfig(),
    });
    const byPort = Object.fromEntries(bogus.map((p) => [p.port, p]));
    expect(byPort[1].traffic).toBeNull();
    expect(byPort[2].traffic).toBeNull();
  });
});

// --- Port naming (WARP-1716) -----------------------------------------------

describe("derivePortName", () => {
  it("names a port by its provisioned role", () => {
    expect(derivePortName({ role: "uplink", rawName: null })).toBe("Uplink");
    expect(derivePortName({ role: "camera", rawName: null })).toBe("Camera");
    expect(derivePortName({ role: "ap", rawName: null })).toBe("Access point");
    expect(derivePortName({ role: "client", rawName: null })).toBe("Client");
  });

  it("prefers the role over a generic driver label", () => {
    expect(derivePortName({ role: "camera", rawName: "Port 7" })).toBe("Camera");
  });

  it("passes through a real name the driver reports for an unknown role", () => {
    expect(derivePortName({ role: "unknown", rawName: "Front desk" })).toBe("Front desk");
  });

  it("discards the driver's generic 'Port N' label in all its spellings", () => {
    for (const raw of ["Port 5", "port5", "PORT  10", "  Port 3  "]) {
      expect(derivePortName({ role: "unknown", rawName: raw })).toBeNull();
    }
  });

  it("treats blank/absent names as no name", () => {
    expect(derivePortName({ role: "unknown", rawName: "" })).toBeNull();
    expect(derivePortName({ role: "unknown", rawName: "   " })).toBeNull();
    expect(derivePortName({ role: "unknown", rawName: null })).toBeNull();
    expect(derivePortName({ role: "unknown", rawName: undefined })).toBeNull();
  });
});

// --- VLANs -----------------------------------------------------------------

describe("aggregateVlans", () => {
  it("reshapes to {vlan_id,name,isolated,ports[]}", () => {
    const out = aggregateVlans(VLANS, makeConfig({ vlan_profile: "segmented" }));
    const byId = Object.fromEntries(out.map((v) => [v.vlan_id, v]));
    expect(byId[1]).toEqual({ vlan_id: 1, name: "LAN", isolated: false, ports: [1, 4] });
    // Camera VLAN under segmented → isolated; ports flattened to int[].
    expect(byId[100].isolated).toBe(true);
    expect(byId[100].ports).toEqual([7, 8, 9]);
  });

  it("camera VLAN is NOT isolated under flat-lan (camera-safe honesty)", () => {
    const out = aggregateVlans(VLANS, makeConfig({ vlan_profile: "flat-lan" }));
    const byId = Object.fromEntries(out.map((v) => [v.vlan_id, v]));
    expect(byId[100].isolated).toBe(false);
  });
});
