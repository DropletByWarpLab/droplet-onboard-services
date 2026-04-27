import { describe, it, expect } from "vitest";
import getCameraLiveUrl from "../../../src/handlers/cameras/get-camera-live-url.js";
import type { ToolContext } from "../../../src/types.js";

const ctx: ToolContext = {
  http: {} as ToolContext["http"],
  prisma: {} as ToolContext["prisma"],
  matter: {} as ToolContext["matter"],
  signal: new AbortController().signal,
};

describe("get_camera_live_url", () => {
  it("rejects bad name", async () => {
    const r = await getCameraLiveUrl.handler({ camera: "bad name!" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("returns dashboard URLs", async () => {
    const r = await getCameraLiveUrl.handler({ camera: "front" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { live_url: string; snapshot_url: string };
      expect(data.live_url).toBe("/cameras/front");
      expect(data.snapshot_url).toBe("/api/cameras/front/snapshot");
    }
  });
});
