import { describe, it, expect } from "vitest";
import getCameraSnapshot from "../../../src/handlers/cameras/get-camera-snapshot.js";
import type { ToolContext } from "../../../src/types.js";

const ctx: ToolContext = {
  http: {} as ToolContext["http"],
  prisma: {} as ToolContext["prisma"],
  matter: {} as ToolContext["matter"],
  signal: new AbortController().signal,
};

describe("get_camera_snapshot", () => {
  it("rejects invalid name", async () => {
    const r = await getCameraSnapshot.handler({ camera: "bad name!" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("returns the snapshot URL for a valid name", async () => {
    const r = await getCameraSnapshot.handler({ camera: "front_door" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { snapshot_url: string };
      expect(data.snapshot_url).toBe("/api/cameras/front_door/snapshot");
    }
  });

  // WARP-3691 - the chat renders `media` as a picture.
  it("includes a camera_snapshot media descriptor with a live URL", async () => {
    const r = await getCameraSnapshot.handler({ camera: "front_door" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { media: unknown };
      expect(data.media).toEqual({
        kind: "camera_snapshot",
        camera: "front_door",
        snapshotUrl: "/api/cameras/front_door/snapshot",
        liveUrl: "/api/cameras/front_door/live",
      });
    }
  });
});
