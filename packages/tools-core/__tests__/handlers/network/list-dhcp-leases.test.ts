import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listDhcpLeases from "../../../src/handlers/network/list-dhcp-leases.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("list_dhcp_leases", () => {
  it("metadata is read-only", () => {
    expect(listDhcpLeases.requiresWrite).toBe(false);
    expect(listDhcpLeases.requiresConfirmation).toBe(false);
  });

  it("normalizes UCI lease shape to mac/ip/hostname/expires", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          leases: [{ macaddr: "AA:BB", ipaddr: "10.0.0.5", hostname: "tv", expire: 1000 }],
        }),
        { status: 200 },
      ),
    );
    const r = await listDhcpLeases.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        leases: [{ mac: "AA:BB", ip: "10.0.0.5", hostname: "tv", expires: 1000 }],
      });
    }
  });

  it("returns ROUTING_UNAVAILABLE on non-2xx", async () => {
    const get = vi.fn().mockResolvedValue(new Response("err", { status: 503 }));
    const r = await listDhcpLeases.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTING_UNAVAILABLE");
  });
});
