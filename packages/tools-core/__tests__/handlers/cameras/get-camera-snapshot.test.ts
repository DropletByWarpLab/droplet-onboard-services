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
});
