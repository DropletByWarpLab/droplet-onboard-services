import { describe, it, expect, vi } from "vitest";
import listDiscoveredCameras from "../../../src/handlers/cameras/list-discovered-cameras.js";
import type { ToolContext } from "../../../src/types.js";

describe("list_discovered_cameras", () => {
  it("queries Prisma for autoDiscovered=true and enabled=false", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "c1",
        name: "Front",
        ipAddress: "10.0.0.5",
        macAddress: "AA:BB",
        manufacturer: "Hanwha",
        model: "X",
        createdAt: new Date("2026-04-01"),
      },
    ]);
    const ctx: ToolContext = {
      prisma: { camera: { findMany } } as unknown as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      matter: {} as ToolContext["matter"],
      signal: new AbortController().signal,
    };
    const r = await listDiscoveredCameras.handler({}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: false, autoDiscovered: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { pending: Array<{ id: string; ip: string }> };
      expect(data.pending).toHaveLength(1);
      expect(data.pending[0].id).toBe("c1");
    }
  });
});
