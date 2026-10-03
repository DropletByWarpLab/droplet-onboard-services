/**
 * WARP-2977 (ADR-059 §3.3) — what a source message means as a SecurityEvent.
 *
 * Payload shapes are Frigate 0.17.1's (`docs/integrations/mqtt.md` at the
 * v0.17.1 tag): `frigate/events` carries `type` new|update|end with the
 * tracked object under `after`; per-camera health is
 * `frigate/<camera>/status/<role>` = online|offline|disabled.
 */
import { describe, it, expect } from "vitest";
import {
  frigateEndToDraft,
  frigateOngoingToDraft,
  ongoingFrigateId,
  parseFrigateInflight,
  parseFrigateStatus,
  statusTransitionToDraft,
  threatRowToDraft,
  SECURITY_MIN_SCORE,
  SECURITY_MIN_DURATION_SEC,
  SECURITY_ONGOING_SUMMARY,
} from "./security-event-ingest.js";

const START = 1_790_000_000; // epoch seconds

function endMessage(after: Record<string, unknown> = {}, type = "end") {
  return {
    type,
    before: {},
    after: {
      id: "1790000000.123456-abc123",
      camera: "front_door",
      label: "person",
      start_time: START,
      end_time: START + 12,
      top_score: 0.86,
      score: 0.8,
      false_positive: false,
      entered_zones: ["porch"],
      ...after,
    },
  };
}

describe("frigateEndToDraft — one row per tracked object, on end", () => {
  it("an end becomes a detection carrying the object's whole life", () => {
    const d = frigateEndToDraft(endMessage());
    expect(d).toEqual({
      source: "frigate",
      kind: "detection",
      severity: "info",
      camera: "front_door",
      sourceRef: "front_door/1790000000.123456-abc123",
      dedupeKey: "frigate:1790000000.123456-abc123",
      labels: ["person"],
      cameraZones: ["porch"],
      score: 0.86,
      startedAt: new Date(START * 1000),
      endedAt: new Date((START + 12) * 1000),
      summary: "Person in porch",
      observed: "live",
    });
  });

  it.each(["new", "update", "something_else"])("a %s message is not stored", (type) => {
    expect(frigateEndToDraft(endMessage({}, type))).toBeNull();
  });

  it("the dedupe key is the Frigate id, so a QoS-1 redelivery maps to the same row", () => {
    expect(frigateEndToDraft(endMessage())!.dedupeKey).toBe(frigateEndToDraft(endMessage())!.dedupeKey);
  });

  it("uses top_score (the best the object ever scored), not the last frame's score", () => {
    expect(frigateEndToDraft(endMessage({ top_score: 0.91, score: 0.4 }))!.score).toBe(0.91);
  });
});

describe("frigateEndToDraft — the detection gate keeps low rows, it does not drop them", () => {
  it(`a best score under ${SECURITY_MIN_SCORE} is detection_low`, () => {
    expect(frigateEndToDraft(endMessage({ top_score: SECURITY_MIN_SCORE - 0.01 }))!.kind).toBe("detection_low");
  });

  it(`exactly ${SECURITY_MIN_SCORE} passes`, () => {
    expect(frigateEndToDraft(endMessage({ top_score: SECURITY_MIN_SCORE }))!.kind).toBe("detection");
  });

  it(`shorter than ${SECURITY_MIN_DURATION_SEC} s is detection_low`, () => {
    expect(frigateEndToDraft(endMessage({ end_time: START + 1.5 }))!.kind).toBe("detection_low");
  });

  it(`exactly ${SECURITY_MIN_DURATION_SEC} s passes`, () => {
    expect(frigateEndToDraft(endMessage({ end_time: START + SECURITY_MIN_DURATION_SEC }))!.kind).toBe("detection");
  });

  it("a false positive is kept as detection_low", () => {
    expect(frigateEndToDraft(endMessage({ false_positive: true }))!.kind).toBe("detection_low");
  });

  it("an end with no end time cannot show its duration, so it is low", () => {
    const d = frigateEndToDraft(endMessage({ end_time: null }))!;
    expect(d.kind).toBe("detection_low");
    expect(d.endedAt).toBeNull();
  });

  it("an out-of-range score is not trusted — stored as null and low", () => {
    const d = frigateEndToDraft(endMessage({ top_score: 7 }))!;
    expect(d.score).toBeNull();
    expect(d.kind).toBe("detection_low");
  });
});

describe("frigateEndToDraft — only well-formed Frigate data is stored", () => {
  it.each([
    ["an id with a slash", { id: "../../etc" }],
    ["a camera with a space", { camera: "front door" }],
    ["an empty label", { label: "" }],
    ["no start time", { start_time: undefined }],
    ["a string start time", { start_time: "yesterday" }],
  ])("%s → null", (_name, patch) => {
    expect(frigateEndToDraft(endMessage(patch))).toBeNull();
  });

  it("a message without `after` → null", () => {
    expect(frigateEndToDraft({ type: "end", before: {} })).toBeNull();
    expect(frigateEndToDraft(null)).toBeNull();
    expect(frigateEndToDraft("end")).toBeNull();
  });

  it("zones: non-strings and unsafe names are dropped, repeats collapse, capped at 16", () => {
    const zones = ["porch", "porch", 3, "bad zone", ...Array.from({ length: 20 }, (_, i) => `z${i}`)];
    const d = frigateEndToDraft(endMessage({ entered_zones: zones }))!;
    expect(d.cameraZones[0]).toBe("porch");
    expect(d.cameraZones).not.toContain("bad zone");
    expect(d.cameraZones).toHaveLength(16);
  });

  it("no zones entered → summary is just the label", () => {
    expect(frigateEndToDraft(endMessage({ entered_zones: [], label: "car" }))!.summary).toBe("Car");
  });
});

describe("parseFrigateStatus — the topics Frigate 0.17 actually publishes", () => {
  it("reads the detect role", () => {
    expect(parseFrigateStatus("frigate/front_door/status/detect", "offline")).toEqual({
      camera: "front_door",
      health: "offline",
    });
    expect(parseFrigateStatus("frigate/front_door/status/detect", " Online \n")).toEqual({
      camera: "front_door",
      health: "online",
    });
    expect(parseFrigateStatus("frigate/front_door/status/detect", "disabled")!.health).toBe("disabled");
  });

  it("ignores the record and audio roles", () => {
    expect(parseFrigateStatus("frigate/front_door/status/record", "offline")).toBeNull();
    expect(parseFrigateStatus("frigate/front_door/status/audio", "offline")).toBeNull();
  });

  it("the old `frigate/<cam>/status` (ON/OFF) shape is not a Frigate topic and is not read", () => {
    // camera.service subscribed to `frigate/+/status` before WARP-2977; MQTT
    // `+` is one level, so it never matched `frigate/<cam>/status/<role>`.
    expect(parseFrigateStatus("frigate/front_door/status", "ON")).toBeNull();
  });

  it("reads Frigate's own LWT; `stopped` counts as offline", () => {
    expect(parseFrigateStatus("frigate/available", "online")).toEqual({ camera: null, health: "online" });
    expect(parseFrigateStatus("frigate/available", "offline")).toEqual({ camera: null, health: "offline" });
    expect(parseFrigateStatus("frigate/available", "stopped")).toEqual({ camera: null, health: "offline" });
  });

  it("an unknown payload → null", () => {
    expect(parseFrigateStatus("frigate/front_door/status/detect", "maybe")).toBeNull();
    expect(parseFrigateStatus("frigate/available", "")).toBeNull();
  });
});

describe("statusTransitionToDraft — only changes are events", () => {
  const now = new Date("2026-09-23T02:14:00Z");
  const cam = (health: "online" | "offline" | "disabled") => ({ camera: "back_door", health });

  it("online → offline is a camera_offline notice", () => {
    const d = statusTransitionToDraft(cam("offline"), "online", now)!;
    expect(d.kind).toBe("camera_offline");
    expect(d.severity).toBe("notice");
    expect(d.camera).toBe("back_door");
    expect(d.startedAt).toBe(now);
  });

  it("offline → online is a camera_online info", () => {
    const d = statusTransitionToDraft(cam("online"), "offline", now)!;
    expect(d.kind).toBe("camera_online");
    expect(d.severity).toBe("info");
  });

  it("the same state again is not news (retained message on reconnect)", () => {
    expect(statusTransitionToDraft(cam("online"), "online", now)).toBeNull();
    expect(statusTransitionToDraft(cam("offline"), "offline", now)).toBeNull();
  });

  it("first sight of a healthy camera is not an event", () => {
    expect(statusTransitionToDraft(cam("online"), null, now)).toBeNull();
  });

  it("a camera that is down when Droplet first sees it IS an event", () => {
    expect(statusTransitionToDraft(cam("offline"), null, now)!.kind).toBe("camera_offline");
  });

  it("disabled is the owner's choice — no row, and the next online is not a recovery", () => {
    expect(statusTransitionToDraft(cam("disabled"), "online", now)).toBeNull();
    expect(statusTransitionToDraft(cam("online"), "disabled", now)).toBeNull();
  });

  it("disabled → offline is still reported (it was turned back on and is down)", () => {
    expect(statusTransitionToDraft(cam("offline"), "disabled", now)!.kind).toBe("camera_offline");
  });

  it("Frigate itself going away is a source_offline with no camera", () => {
    const d = statusTransitionToDraft({ camera: null, health: "offline" }, "online", now)!;
    expect(d.kind).toBe("source_offline");
    expect(d.camera).toBeNull();
    expect(d.sourceRef).toBe("frigate/available");
  });

  it("two transitions at different instants get different dedupe keys", () => {
    const a = statusTransitionToDraft(cam("offline"), "online", now)!;
    const b = statusTransitionToDraft(cam("offline"), "online", new Date(now.getTime() + 60_000))!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe("threatRowToDraft — a pointer to the chain row, not a copy of it", () => {
  const row = {
    id: 41_207n,
    at: new Date("2026-09-23T02:10:00Z"),
    kind: "auth" as const,
    severity: "warn" as const,
    what: "5 failed sign-ins for admin from 192.168.9.44",
  };

  it("warn → notice, err → alert", () => {
    expect(threatRowToDraft(row).severity).toBe("notice");
    expect(threatRowToDraft({ ...row, severity: "err" }).severity).toBe("alert");
  });

  it("keyed by the ActivityRow id, never tied to a camera", () => {
    const d = threatRowToDraft(row);
    expect(d.dedupeKey).toBe("activity:41207");
    expect(d.sourceRef).toBe("activity:41207");
    expect(d.camera).toBeNull();
    expect(d.labels).toEqual(["auth"]);
    expect(d.startedAt).toBe(row.at);
  });

  it("a long `what` is capped", () => {
    expect(threatRowToDraft({ ...row, what: "x".repeat(2_000) }).summary).toHaveLength(500);
  });
});

describe("observed (WARP-2977 P2b-2) — every P2a row is timed when it happened", () => {
  it("detections, camera and Frigate status rows and mirrored threats are all `live`; only the lock sweep writes `polled`", () => {
    expect(frigateEndToDraft(endMessage())!.observed).toBe("live");
    expect(statusTransitionToDraft({ camera: "back_door", health: "offline" }, "online", new Date(0))!.observed).toBe("live");
    expect(statusTransitionToDraft({ camera: null, health: "offline" }, "online", new Date(0))!.observed).toBe("live");
    expect(
      threatRowToDraft({ id: 1n, at: new Date(0), kind: "network", severity: "warn", what: "x" }).observed,
    ).toBe("live");
    // WARP-2978 PR-D: a person still in view is timed from when Frigate started tracking them.
    expect(
      frigateOngoingToDraft({
        id: "1790000000.123456-abc123",
        camera: "front_door",
        label: "person",
        startedAt: new Date(0),
        topScore: 0.9,
        enteredZones: [],
      }).observed,
    ).toBe("live");
  });
});

// ── WARP-2978 PR-D (ADR-059 P3 §6.12) — early presence ──────────────────

describe("parseFrigateInflight — the raw new/update/end messages the in-flight map keeps", () => {
  it("new and update are a track: the object so far (best score, Frigate's verdict, the zones entered)", () => {
    for (const type of ["new", "update"]) {
      expect(parseFrigateInflight(endMessage({ end_time: null }, type))).toEqual({
        type: "track",
        id: "1790000000.123456-abc123",
        camera: "front_door",
        label: "person",
        startedAt: new Date(START * 1000),
        topScore: 0.86,
        falsePositive: false,
        enteredZones: ["porch"],
      });
    }
  });

  it("end needs only the id — the entry is forgotten", () => {
    expect(parseFrigateInflight(endMessage())).toEqual({ type: "end", id: "1790000000.123456-abc123" });
    expect(parseFrigateInflight(endMessage({ camera: "../x", label: 7 }))).toEqual({ type: "end", id: "1790000000.123456-abc123" });
  });

  it("keeps Frigate's own false-positive verdict, and an out-of-range score as unknown", () => {
    expect(parseFrigateInflight(endMessage({ false_positive: true }, "update"))).toMatchObject({ falsePositive: true });
    expect(parseFrigateInflight(endMessage({ top_score: 1.3 }, "update"))).toMatchObject({ topScore: null });
    expect(parseFrigateInflight(endMessage({ top_score: "0.9" }, "update"))).toMatchObject({ topScore: null });
    expect(parseFrigateInflight(endMessage({ entered_zones: ["porch", "porch", "../x", 3, "till"] }, "update"))).toMatchObject({
      enteredZones: ["porch", "till"],
    });
  });

  it.each([
    ["an unknown type", endMessage({}, "snapshot")],
    ["no after", { type: "update" }],
    ["a bad id", endMessage({ id: "a b" }, "update")],
    ["a bad camera", endMessage({ camera: "a/b" }, "update")],
    ["a bad label", endMessage({ label: "" }, "update")],
    ["no start time", endMessage({ start_time: 0 }, "update")],
    ["an end with a bad id", endMessage({ id: "" })],
    ["not an object", "frigate"],
  ])("ignores %s", (_name, message) => {
    expect(parseFrigateInflight(message)).toBeNull();
  });
});

describe("frigateOngoingToDraft — the ONE still-in-view row of a person", () => {
  const o = {
    id: "1790000000.123456-abc123",
    camera: "front_door",
    label: "person",
    startedAt: new Date(START * 1000),
    topScore: 0.86,
    enteredZones: ["porch"],
  };

  it("is a Frigate detection_ongoing row: started when tracking did, not ended, keyed in its own namespace", () => {
    expect(frigateOngoingToDraft(o)).toEqual({
      source: "frigate",
      kind: "detection_ongoing",
      severity: "info",
      camera: "front_door",
      sourceRef: "front_door/1790000000.123456-abc123",
      dedupeKey: "frigate-ongoing:1790000000.123456-abc123",
      labels: ["person"],
      cameraZones: ["porch"],
      score: 0.86,
      startedAt: new Date(START * 1000),
      endedAt: null,
      summary: "Person still in view after 30 s",
      observed: "live",
    });
    expect(SECURITY_ONGOING_SUMMARY).toBe("Person still in view after 30 s");
  });

  it("never shares the key of the same object's end row (both rows are kept)", () => {
    const end = frigateEndToDraft(endMessage())!;
    expect(frigateOngoingToDraft(o).dedupeKey).not.toBe(end.dedupeKey);
    expect(frigateOngoingToDraft(o).sourceRef).toBe(end.sourceRef);
  });

  it("ongoingFrigateId reads the id back from the key, and nothing from any other key", () => {
    expect(ongoingFrigateId("frigate-ongoing:1790000000.123456-abc123")).toBe("1790000000.123456-abc123");
    expect(ongoingFrigateId("frigate:1790000000.123456-abc123")).toBeNull();
    expect(ongoingFrigateId("frigate-ongoing:")).toBeNull();
    expect(ongoingFrigateId("frigate-ongoing:a b")).toBeNull();
  });
});
