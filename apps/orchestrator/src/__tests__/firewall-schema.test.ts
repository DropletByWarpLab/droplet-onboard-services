/**
 * WARP-42: zod contract for the firewall wire shape on the orchestrator side.
 *
 * Mirrors the pytest suite in `services/routing/tests/test_firewall_schemas.py`
 * so schema drift in either direction breaks a test.
 */

import { describe, it, expect } from "vitest";
import {
  FirewallZoneSchema,
  FirewallRuleSchema,
  FirewallRedirectSchema,
  FirewallZonesSchema,
  FirewallRulesSchema,
  FirewallRedirectsSchema,
} from "../types/firewall-schema.js";

describe("FirewallZoneSchema (WARP-42)", () => {
  it("parses a typical lan zone", () => {
    const parsed = FirewallZoneSchema.parse({
      ".anonymous": false,
      ".type": "zone",
      ".name": "cfg01abc",
      name: "lan",
      network: ["lan"],
      input: "ACCEPT",
      output: "ACCEPT",
      forward: "ACCEPT",
    });
    expect(parsed.name).toBe("lan");
    expect(parsed.network).toEqual(["lan"]);
    expect(parsed.input).toBe("ACCEPT");
  });

  it("accepts string network", () => {
    const parsed = FirewallZoneSchema.parse({ name: "wan", network: "wan" });
    expect(parsed.network).toBe("wan");
  });

  it("preserves unknown fields via passthrough", () => {
    const parsed = FirewallZoneSchema.parse({
      name: "guest",
      ".type": "zone",
      custom_future_field: "xyz",
    });
    expect(parsed[".type"]).toBe("zone");
    expect(parsed.custom_future_field).toBe("xyz");
  });

  it("all fields optional", () => {
    const parsed = FirewallZoneSchema.parse({});
    expect(parsed.name).toBeUndefined();
  });
});

describe("FirewallRuleSchema (WARP-42)", () => {
  it("parses a block rule", () => {
    const parsed = FirewallRuleSchema.parse({
      name: "block-aabbccddeeff",
      src: "lan",
      dest: "wan",
      src_mac: "aa:bb:cc:dd:ee:ff",
      target: "REJECT",
      enabled: "1",
    });
    expect(parsed.target).toBe("REJECT");
    expect(parsed.src_mac).toBe("aa:bb:cc:dd:ee:ff");
  });

  it("accepts proto as list", () => {
    const parsed = FirewallRuleSchema.parse({ name: "x", proto: ["tcp", "udp"] });
    expect(parsed.proto).toEqual(["tcp", "udp"]);
  });
});

describe("FirewallRedirectSchema (WARP-42)", () => {
  it("parses a port forward", () => {
    const parsed = FirewallRedirectSchema.parse({
      name: "ssh",
      src: "wan",
      dest: "lan",
      proto: "tcp",
      src_dport: "22",
      dest_ip: "10.0.0.5",
      dest_port: "22",
      target: "DNAT",
      enabled: "1",
    });
    expect(parsed.dest_ip).toBe("10.0.0.5");
    expect(parsed.target).toBe("DNAT");
  });
});

describe("Firewall*CollectionSchema (WARP-42)", () => {
  it("zones collection with multiple sections", () => {
    const parsed = FirewallZonesSchema.parse({
      values: {
        cfg01abc: { name: "lan", input: "ACCEPT" },
        cfg02def: { name: "wan", input: "REJECT" },
      },
    });
    expect(Object.keys(parsed.values)).toHaveLength(2);
    expect(parsed.values.cfg01abc.name).toBe("lan");
  });

  it("rules collection empty", () => {
    const parsed = FirewallRulesSchema.parse({ values: {} });
    expect(parsed.values).toEqual({});
  });

  it("redirects collection missing values defaults to empty", () => {
    const parsed = FirewallRedirectsSchema.parse({});
    expect(parsed.values).toEqual({});
  });

  it("rejects non-dict values", () => {
    expect(() => FirewallZonesSchema.parse({ values: "not a dict" })).toThrow();
  });

  it("preserves unknown outer keys (e.g. `changes` from uci.get)", () => {
    const parsed = FirewallZonesSchema.parse({
      values: {},
      changes: [{ foo: "bar" }],
    });
    expect(parsed.changes).toBeDefined();
  });
});
