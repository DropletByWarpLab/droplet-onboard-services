/**
 * WARP-3509 — an event's clip plays as HLS, so the modal needs the playlist's
 * URL. Frigate's clip.mp4 is a fragmented mp4 a <video src> cannot read a
 * duration from or seek in; the playlist is the same footage the Recordings
 * page plays, through the orchestrator's signed-segment proxy.
 */
import { describe, it, expect } from "vitest";
import { getEventHlsUrl } from "./api";

describe("getEventHlsUrl", () => {
  it("is the event's playback playlist on the orchestrator", () => {
    expect(getEventHlsUrl("1791059989.433851-abc123")).toBe(
      "/api/cameras/events/1791059989.433851-abc123/playback.m3u8",
    );
  });

  it("never points at the fragmented clip.mp4", () => {
    expect(getEventHlsUrl("ev-1")).not.toContain("clip");
    expect(getEventHlsUrl("ev-1")).not.toContain(".mp4");
  });

  it("encodes the id", () => {
    expect(getEventHlsUrl("a b/c")).toBe("/api/cameras/events/a%20b%2Fc/playback.m3u8");
  });

  it("the first load carries no query", () => {
    expect(getEventHlsUrl("ev-1", 0)).toBe("/api/cameras/events/ev-1/playback.m3u8");
  });

  it("each refresh is a new URL, so the player loads the playlist again", () => {
    // An event in progress reaches further each time the playlist is asked for;
    // hls.js only reloads when its source string changes.
    expect(getEventHlsUrl("ev-1", 1)).toBe("/api/cameras/events/ev-1/playback.m3u8?refresh=1");
    expect(getEventHlsUrl("ev-1", 2)).not.toBe(getEventHlsUrl("ev-1", 1));
  });
});
