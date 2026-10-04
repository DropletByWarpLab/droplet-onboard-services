/**
 * WARP-3632 — the network read tools refuse an external guest (and an absent
 * role) before any query or HTTP call, and `get_wifi_settings` is
 * owner/admin only, matching `GET /api/network/wifi`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Role, ToolContext } from "../../../src/types.js";
import { TOOLS } from "../../../src/registry.js";

const MEMBER_FLOOR = [
  "list_network_devices",
  "list_ap_devices",
  "list_dhcp_leases",
  "get_firewall_rules",
  "get_router_system_info",
  "scan_wifi_networks",
  "get_switch_ports",
  "get_switch_vlans",
  "get_switch_poe",
];
const ADMIN_FLOOR = ["get_wifi_settings"];

function ctxFor(role: Role | undefined) {
  const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const findMany = vi.fn().mockResolvedValue([]);
  const ctx = {
    http: { orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
    prisma: { networkDevice: { findMany }, apDevice: { findMany } },
    matter: {},
    signal: new AbortController().signal,
    ...(role ? { role } : {}),
  } as unknown as ToolContext;
  return { ctx, get, findMany };
}

async function run(name: string, role: Role | undefined) {
  const { ctx, get, findMany } = ctxFor(role);
  const r = await TOOLS.get(name)!.handler({}, ctx);
  return { r, touched: get.mock.calls.length + findMany.mock.calls.length };
}

const forbidden = (r: Awaited<ReturnType<typeof run>>["r"]) =>
  !r.ok && r.error.code === "FORBIDDEN";

describe("member-floored network read tools", () => {
  it.each(MEMBER_FLOOR)("%s: guest and absent role are FORBIDDEN before any read", async (name) => {
    for (const role of ["guest", undefined] as const) {
      const { r, touched } = await run(name, role);
      expect(forbidden(r), `${name} as ${role}`).toBe(true);
      expect(touched).toBe(0);
    }
  });

  it.each(MEMBER_FLOOR)("%s: owner, admin and member pass the gate", async (name) => {
    for (const role of ["owner", "admin", "family"] as const) {
      const { r } = await run(name, role);
      expect(forbidden(r), `${name} as ${role}`).toBe(false);
    }
  });
});

describe("admin-floored network read tools", () => {
  it.each(ADMIN_FLOOR)("%s: member, guest and absent role are FORBIDDEN", async (name) => {
    for (const role of ["family", "guest", undefined] as const) {
      const { r, touched } = await run(name, role);
      expect(forbidden(r), `${name} as ${role}`).toBe(true);
      expect(touched).toBe(0);
    }
  });

  it.each(ADMIN_FLOOR)("%s: owner and admin pass the gate", async (name) => {
    for (const role of ["owner", "admin"] as const) {
      const { r } = await run(name, role);
      expect(forbidden(r), `${name} as ${role}`).toBe(false);
    }
  });
});
