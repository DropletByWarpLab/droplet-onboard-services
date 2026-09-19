import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listCameras from "../../../src/handlers/cameras/list-cameras.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      // WARP-339: list_cameras now calls `ctx.http.orchestrator.get`
      // (auto-injects the service-principal JWT), not the per-service
      // `ctx.http.cameras.get`. Mock the right one — the previous test
      // mocked `cameras.get` and crashed with "Cannot read properties
      // of undefined (reading 'get')" because `orchestrator` was a
      // bare object cast.
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

describe("list_cameras", () => {
  it("returns ok and redacts IP/MAC in cameras array", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          cameras: [
            { name: "front", ipAddress: "10.0.0.5", macAddress: "AA:BB" },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await listCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cams = (r.data as { cameras: Array<Record<string, unknown>> }).cameras;
      expect(cams[0]).not.toHaveProperty("ipAddress");
      expect(cams[0]).not.toHaveProperty("macAddress");
    }
  });

  it("error on 503", async () => {
    const get = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    const r = await listCameras.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
  });
});
