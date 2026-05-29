import { describe, it, expect, beforeEach } from "vitest";
import {
  processCameraEvent,
  resetCameraEventGateForTests,
  MIN_GAP_AFTER_RECORDING_MS,
  MAX_ACTIVE_MS,
} from "../services/camera-event-gate.js";

// These tests cover the per-camera real-time event gate that suppresses
// dashboard / push saturation. The rules, per WARP "camera-event saturation"
// fix:
//
//   1. A new event for camera X is accepted only when no prior event is
//      still recording AND >= MIN_GAP_AFTER_RECORDING_MS have elapsed
//      since the prior event's `type=end` from Frigate. The first event
//      a camera ever sees is accepted unconditionally.
//   2. While an event is active (between its own "new" and "end"), the
//      gate accepts `update` messages whose eventId matches, so the
//      cameras page can show live confidence. Updates for a different
//      eventId are dropped (stale).
//   3. `end` matching the active event releases the gate and starts the
//      5s cooldown. `end` not matching the active event is ignored.
//   4. Per-camera isolation — busy front-door does not block back-yard.
//   5. Safety: if no `end` arrives within MAX_ACTIVE_MS the gate
//      auto-releases (Frigate crash / dropped MQTT message).

beforeEach(() => {
  resetCameraEventGateForTests();
});

describe("processCameraEvent — accept first event", () => {
  it("accepts the first new event for a camera", () => {
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e1",
      frigateType: "new",
      now: 1_000,
    });
    expect(d.kind).toBe("accept_new");
  });
});

describe("processCameraEvent — block while previous still recording", () => {
  it("drops a new event while the previous event is still active", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e2",
      frigateType: "new",
      now: 2_000,
    });
    expect(d.kind).toBe("drop_active");
  });
});

describe("processCameraEvent — cooldown after recording ends", () => {
  it("drops a new event within MIN_GAP_AFTER_RECORDING_MS of the previous end", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "end", now: 3_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e2",
      frigateType: "new",
      now: 3_000 + MIN_GAP_AFTER_RECORDING_MS - 1,
    });
    expect(d.kind).toBe("drop_cooldown");
  });

  it("accepts a new event once MIN_GAP_AFTER_RECORDING_MS has elapsed since the previous end", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "end", now: 3_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e2",
      frigateType: "new",
      now: 3_000 + MIN_GAP_AFTER_RECORDING_MS,
    });
    expect(d.kind).toBe("accept_new");
  });
});

describe("processCameraEvent — per-camera isolation", () => {
  it("does not let one camera block another", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const d = processCameraEvent({
      cameraName: "back",
      eventId: "b1",
      frigateType: "new",
      now: 1_100,
    });
    expect(d.kind).toBe("accept_new");
  });
});

describe("processCameraEvent — updates", () => {
  it("accepts update messages that match the active event", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e1",
      frigateType: "update",
      now: 1_500,
    });
    expect(d.kind).toBe("accept_update");
  });

  it("drops update messages for a stale event id", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "different",
      frigateType: "update",
      now: 1_500,
    });
    expect(d.kind).toBe("drop_stale");
  });

  it("drops update messages when no event is active", () => {
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e1",
      frigateType: "update",
      now: 1_500,
    });
    expect(d.kind).toBe("drop_stale");
  });
});

describe("processCameraEvent — end semantics", () => {
  it("accepts end matching the active event and releases the gate", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const end = processCameraEvent({
      cameraName: "front",
      eventId: "e1",
      frigateType: "end",
      now: 3_000,
    });
    expect(end.kind).toBe("accept_end");
  });

  it("drops end for a non-active event id without releasing the gate", () => {
    processCameraEvent({ cameraName: "front", eventId: "e1", frigateType: "new", now: 1_000 });
    const stray = processCameraEvent({
      cameraName: "front",
      eventId: "stray",
      frigateType: "end",
      now: 2_000,
    });
    expect(stray.kind).toBe("drop_stale");

    // Active event is still active — a new event should still be blocked.
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e2",
      frigateType: "new",
      now: 2_500,
    });
    expect(d.kind).toBe("drop_active");
  });
});

describe("processCameraEvent — safety timeout for stuck active", () => {
  it("auto-releases an active event after MAX_ACTIVE_MS so the gate does not get wedged", () => {
    processCameraEvent({ cameraName: "front", eventId: "stuck", frigateType: "new", now: 1_000 });
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e2",
      frigateType: "new",
      now: 1_000 + MAX_ACTIVE_MS + 1,
    });
    expect(d.kind).toBe("accept_new");
  });
});

describe("processCameraEvent — guards", () => {
  it("rejects unknown frigate types as drop_stale", () => {
    const d = processCameraEvent({
      cameraName: "front",
      eventId: "e1",
      // @ts-expect-error — exercising the runtime guard
      frigateType: "bogus",
      now: 1_000,
    });
    expect(d.kind).toBe("drop_stale");
  });

  it("rejects empty cameraName / eventId as drop_stale", () => {
    const a = processCameraEvent({ cameraName: "", eventId: "e1", frigateType: "new", now: 1 });
    const b = processCameraEvent({ cameraName: "front", eventId: "", frigateType: "new", now: 1 });
    expect(a.kind).toBe("drop_stale");
    expect(b.kind).toBe("drop_stale");
  });
});
