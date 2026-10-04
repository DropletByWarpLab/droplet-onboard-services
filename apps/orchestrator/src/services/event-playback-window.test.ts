/**
 * WARP-3509 — the HLS window an event clip plays over.
 *
 * Frigate's `clip.mp4` for an event is one fragmented MP4 that ffmpeg streams
 * on the fly, which a browser cannot read a duration from or seek in. The clip
 * plays as HLS instead, over the recordings of the window around the event:
 * the footage Frigate keeps for an event is its start and end plus the
 * pre/post-capture padding, so that is the window asked for.
 */
import { describe, it, expect } from "vitest";
import { eventPlaybackWindow, MAX_EVENT_PLAYBACK_SEC } from "./event-playback-window.js";

const PAD = { preSec: 20, postSec: 20 };
/** Far enough after every fixture event that `now` never clamps unless a test wants it to. */
const NOW = 2_000_000_000;

describe("eventPlaybackWindow", () => {
  it("runs from the start minus the pre-capture to the end plus the post-capture", () => {
    expect(eventPlaybackWindow({ startTime: 1_800_000_100, endTime: 1_800_000_112 }, PAD, NOW)).toEqual({
      after: 1_800_000_080,
      before: 1_800_000_132,
    });
  });

  it("rounds outward to whole seconds, so the window never starts late or ends early", () => {
    // 100.9 - 20 = 80.9 → 80;  112.1 + 20 = 132.1 → 133.
    expect(eventPlaybackWindow({ startTime: 1_800_000_100.9, endTime: 1_800_000_112.1 }, PAD, NOW)).toEqual({
      after: 1_800_000_080,
      before: 1_800_000_133,
    });
  });

  it("uses the padding it is given", () => {
    expect(
      eventPlaybackWindow({ startTime: 1_800_000_100, endTime: 1_800_000_112 }, { preSec: 5, postSec: 0 }, NOW),
    ).toEqual({ after: 1_800_000_095, before: 1_800_000_112 });
  });

  it("an event still in progress runs to now, with no post-capture past the present", () => {
    const now = 1_800_000_150;

    expect(eventPlaybackWindow({ startTime: 1_800_000_100, endTime: null }, PAD, now)).toEqual({
      after: 1_800_000_080,
      before: now,
    });
  });

  it("an event that has only just ended stops at now: footage cannot exist ahead of the clock", () => {
    const now = 1_800_000_115; // 3 s after the end, 17 s short of the post-capture

    expect(eventPlaybackWindow({ startTime: 1_800_000_100, endTime: 1_800_000_112 }, PAD, now).before).toBe(now);
  });

  it("stops at the cap for an event that has run longer than it", () => {
    // A parked car is an event for as long as it is parked.
    const start = 1_800_000_000;
    const window = eventPlaybackWindow({ startTime: start, endTime: start + 5 * 3600 }, PAD, NOW);

    expect(window.after).toBe(start - 20);
    expect(window.before).toBe(start - 20 + MAX_EVENT_PLAYBACK_SEC);
  });

  it("caps an in-progress event the same way", () => {
    const start = 1_800_000_000;
    const window = eventPlaybackWindow({ startTime: start, endTime: null }, PAD, start + 5 * 3600);

    expect(window.before - window.after).toBe(MAX_EVENT_PLAYBACK_SEC);
  });

  it("the cap is an hour, the Recordings page's own window", () => {
    expect(MAX_EVENT_PLAYBACK_SEC).toBe(3600);
  });

  it("always leaves a window to play: an event starting at the clock reads as one second, not an inverted range", () => {
    const now = 1_800_000_000;
    const window = eventPlaybackWindow({ startTime: now + 60, endTime: null }, { preSec: 0, postSec: 0 }, now);

    expect(window.before).toBeGreaterThan(window.after);
  });

  it("returns whole seconds", () => {
    const { after, before } = eventPlaybackWindow({ startTime: 1_800_000_100.5, endTime: 1_800_000_111.25 }, PAD, NOW);

    expect(Number.isInteger(after)).toBe(true);
    expect(Number.isInteger(before)).toBe(true);
  });
});
