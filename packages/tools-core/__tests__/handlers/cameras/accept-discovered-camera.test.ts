import { describe, it, expect, vi } from "vitest";
import acceptDiscoveredCamera from "../../../src/handlers/cameras/accept-discovered-camera.js";
import type { ToolContext } from "../../../src/types.js";

describe("accept_discovered_camera", () => {
  it("requiresWrite is true", () => {
    expect(acceptDiscoveredCamera.requiresWrite).toBe(true);
  });

  it("rejects missing id", async () => {
    const ctx: ToolContext = {
      prisma: { camera: { update: vi.fn() } } as unknown as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      matter: {} as ToolContext["matter"],
      signal: new AbortController().signal,
    };
    const r = await acceptDiscoveredCamera.handler({}, ctx);
    expect(r.ok).toBe(false);
  });

  it("updates the camera and returns accepted", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1", name: "Front", enabled: true });
    const ctx: ToolContext = {
      prisma: { camera: { update } } as unknown as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      matter: {} as ToolContext["matter"],
      signal: new AbortController().signal,
    };
    const r = await acceptDiscoveredCamera.handler({ id: "c1" }, ctx);
    expect(update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { enabled: true } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "accepted", camera: "Front" });
  });
});
