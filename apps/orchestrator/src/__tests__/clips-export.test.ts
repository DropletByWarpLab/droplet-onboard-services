import { describe, it, expect, beforeEach, vi } from "vitest";

const ncCreateDirectory = vi.fn();
const ncUploadFile = vi.fn();
vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateDirectory: (...a: unknown[]) => ncCreateDirectory(...a),
  ncUploadFile: (...a: unknown[]) => ncUploadFile(...a),
}));
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate.test:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { exportClip } from "../services/clips.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  ncCreateDirectory.mockResolvedValue(undefined);
  ncUploadFile.mockResolvedValue(undefined);
  global.fetch = vi.fn().mockImplementation(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("FAKE_MP4_BYTES"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "video/mp4" } });
  });
});

describe("exportClip", () => {
  it("writes the rendered clip to /Clips/{camera}/{ts}.mp4 in Nextcloud", async () => {
    const result = await exportClip("nctok", "alice", {
      camera: "front",
      startsAt: new Date("2026-04-23T14:00:00Z"),
      endsAt: new Date("2026-04-23T14:01:00Z"),
    });
    expect(result.ncPath).toBe("/Clips/front/20260423-140000Z.mp4");
    expect(result.bytes).toBe(Buffer.byteLength("FAKE_MP4_BYTES"));
    expect(result.durationSec).toBe(60);
    expect(ncCreateDirectory).toHaveBeenCalledTimes(2); // /Clips, /Clips/front
    expect(ncUploadFile).toHaveBeenCalledWith(
      "nctok", "alice", "/Clips/front", "20260423-140000Z.mp4", expect.any(Buffer),
    );
  });

  it("rejects an invalid camera name", async () => {
    await expect(
      exportClip("nctok", "alice", {
        camera: "front; rm -rf /",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T14:01:00Z"),
      }),
    ).rejects.toThrow(/invalid_camera_name/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a backwards time range", async () => {
    await expect(
      exportClip("nctok", "alice", {
        camera: "front",
        startsAt: new Date("2026-04-23T14:01:00Z"),
        endsAt: new Date("2026-04-23T14:00:00Z"),
      }),
    ).rejects.toThrow(/must be after/);
  });

  it("caps clip duration at 60 minutes", async () => {
    await expect(
      exportClip("nctok", "alice", {
        camera: "front",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T15:00:01Z"),
      }),
    ).rejects.toThrow(/60 minutes/);
  });

  it("surfaces a Frigate non-200 as frigate_export_failed", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("upstream down", { status: 503, statusText: "Service Unavailable" }));
    await expect(
      exportClip("nctok", "alice", {
        camera: "front",
        startsAt: new Date("2026-04-23T14:00:00Z"),
        endsAt: new Date("2026-04-23T14:01:00Z"),
      }),
    ).rejects.toThrow(/frigate_export_failed: 503/);
  });
});
