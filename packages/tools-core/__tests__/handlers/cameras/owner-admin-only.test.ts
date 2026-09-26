// add-llm-tool:not-a-gate — only camera write tools are checked here; its own failure names the fix.
/**
 * WARP-3104 — every camera write tool refuses a non-owner/admin caller in its
 * own RBAC, before any HTTP, and the list below is the whole set of camera
 * write tools (a new one has to be added here, and so gated).
 */
import { describe, it, expect, vi } from "vitest";
import type { Tool, ToolContext } from "../../../src/types.js";
import acceptDiscoveredCamera from "../../../src/handlers/cameras/accept-discovered-camera.js";
import deleteClip from "../../../src/handlers/cameras/delete-clip.js";
import exportClip from "../../../src/handlers/cameras/export-clip.js";
import renameCamera from "../../../src/handlers/cameras/rename-camera.js";
import scanForCameras from "../../../src/handlers/cameras/scan-for-cameras.js";
import setCameraDetection from "../../../src/handlers/cameras/set-camera-detection.js";
import setDetectionZones from "../../../src/handlers/cameras/set-detection-zones.js";
import shareClip from "../../../src/handlers/cameras/share-clip.js";
import { TOOLS } from "../../../src/registry.js";

const GATED: Tool[] = [
  acceptDiscoveredCamera, deleteClip, exportClip, renameCamera,
  scanForCameras, setCameraDetection, setDetectionZones, shareClip,
];

function ctx(role: ToolContext["role"]) {
  const fail = () => vi.fn(async () => new Response("{}", { status: 500 }));
  const http = () => ({ get: fail(), post: fail(), patch: fail(), delete: fail() });
  const c = {
    http: {
      cameras: http(), orchestrator: http(), routing: http(), switchSvc: http(),
      fileIndexer: http(), nextcloud: http(),
    },
    prisma: {},
    matter: {},
    signal: new AbortController().signal,
    role,
  };
  return c as unknown as ToolContext & { http: Record<string, Record<string, ReturnType<typeof vi.fn>>> };
}

describe("camera write tools are owner/admin only in their own RBAC", () => {
  it.each(GATED.map((t) => [t.name, t] as const))("%s refuses family, guest and no role before any HTTP", async (_n, tool) => {
    for (const role of ["family", "guest", "service", undefined] as const) {
      const c = ctx(role as ToolContext["role"]);
      const res = await tool.handler({ camera: "front", confirmed: true }, c);
      expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      for (const client of Object.values(c.http)) {
        for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
      }
    }
  });

  it.each(GATED.map((t) => [t.name, t] as const))("%s lets an admin through to its own logic", async (_n, tool) => {
    const res = await tool.handler({}, ctx("admin"));
    expect(res).not.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("the list covers every camera write tool in the registry", () => {
    const cameraWrites = [...TOOLS.values()]
      // setup_camera_ports is a switch tool (VLAN layout), gated by the switch routes.
      .filter((t) => t.requiresWrite && /camera|clip|detection_zones/.test(t.name) && t.name !== "setup_camera_ports")
      .map((t) => t.name)
      .sort();
    expect(cameraWrites).toEqual(GATED.map((t) => t.name).sort());
  });
});
