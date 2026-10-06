import { describe, expect, it } from "vitest";
import { cameraDetectionDetail } from "./camera-detection";

describe("cameraDetectionDetail", () => {
  it("encodes event IDs as one path segment and derives only authenticated media URLs", () => {
    const detail = cameraDetectionDetail({
      id: "event/id?#",
      camera: "front_door",
      label: "person",
      score: 0.9,
      startTime: 1,
      endTime: null,
      thumbnail: "https://external.example/image",
      hasClip: true,
      hasSnapshot: true,
    });
    expect(detail.thumbnail).toBe(
      "/api/cameras/events/event%2Fid%3F%23/thumbnail",
    );
    expect(detail.snapshotUrl).toBe(
      "/api/cameras/events/event%2Fid%3F%23/snapshot",
    );
    expect(detail.clipUrl).toBe("/api/cameras/clips/event/event%2Fid%3F%23");
  });
});
