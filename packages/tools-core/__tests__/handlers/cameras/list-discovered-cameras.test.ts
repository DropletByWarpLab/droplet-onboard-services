import { describe, it, expect, vi } from "vitest";
import listDiscoveredCameras from "../../../src/handlers/cameras/list-discovered-cameras.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * WARP-1847 — this tool used to query Prisma for
 * `{ enabled: false, autoDiscovered: true }`, a shape the discovery upsert never
 * wrote (Camera.enabled defaults to true), so it always answered "nothing found"
 * while camera-discovery held a live pending list. It now reads the orchestrator's
 * merged candidate list, the same one the dashboard renders.
 */
function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const CANDIDATE = {
  id: "mac:E4:30:22:50:2A:FD",
  name: "XNV_C8083R",
  ip: "192.168.9.219",
  mac: "E4:30:22:50:2A:FD",
  manufacturer: "Hanwha",
  model: "XNV-C8083R",
  status: "needs_credentials",
  hasCredentials: false,
  discoveredAt: "2026-08-10T00:00:00.000Z",
};

describe("list_discovered_cameras", () => {
  it("reads the orchestrator's candidate list", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cameras: [CANDIDATE], discoveryOnline: true }), {
        status: 200,
      }),
    );
    const r = await listDiscoveredCameras.handler({}, ctxWithGet(get));

    expect(get).toHaveBeenCalledWith("/api/cameras/discovered", {
      headers: { Accept: "application/json" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        pending: Array<Record<string, unknown>>;
        discovery_online: boolean;
      };
      expect(data.pending).toHaveLength(1);
      expect(data.pending[0].id).toBe("mac:E4:30:22:50:2A:FD");
      expect(data.pending[0].status).toBe("needs_credentials");
      expect(data.pending[0].needs_credentials).toBe(true);
      expect(data.discovery_online).toBe(true);
    }
  });

  it("keeps addresses out of the model's context", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cameras: [CANDIDATE], discoveryOnline: true }), {
        status: 200,
      }),
    );
    const r = await listDiscoveredCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = (r.data as { pending: Array<Record<string, unknown>> }).pending[0];
      expect(row).not.toHaveProperty("ip");
      expect(row).not.toHaveProperty("mac");
    }
  });

  it("reports discovery_online false so the model can say nothing is scanning", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cameras: [], discoveryOnline: false }), { status: 200 }),
    );
    const r = await listDiscoveredCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { discovery_online: boolean }).discovery_online).toBe(false);
    }
  });

  it("caps the list at 20 rows", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...CANDIDATE, id: `mac:${i}` }));
    const get = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ cameras: many, discoveryOnline: true }), { status: 200 }),
      );
    const r = await listDiscoveredCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { pending: unknown[] }).pending).toHaveLength(20);
    }
  });

  it("errors when the orchestrator read fails instead of claiming an empty network", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const r = await listDiscoveredCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DISCOVERY_UNAVAILABLE");
  });

  it("is a read tool", () => {
    expect(listDiscoveredCameras.requiresWrite).toBe(false);
  });
});
