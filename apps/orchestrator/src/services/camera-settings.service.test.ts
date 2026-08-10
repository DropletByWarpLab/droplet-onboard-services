/**
 * WARP-1849 — per-camera settings must save through the AUTHORED yaml and
 * must target the retention keys Frigate 0.17 actually reads.
 *
 * Two independent defects are locked down here, both measured against the
 * live appliance running Frigate 0.17.1.
 *
 * 1. The save path posted the RESOLVED `/api/config` tree back to
 *    `/api/config/save`. That tree carries computed-only fields
 *    (`model.colormap`, `model.all_attributes`, `auth.roles` with the
 *    reserved names…) and Frigate's config models are `extra="forbid"`, so
 *    an untouched resolved config produced **42** validation errors on the
 *    way back in. No per-camera setting could be saved at all.
 *
 * 2. Retention was written to `record.retain.days`. Frigate 0.17 removed
 *    that field; because extras are forbidden it is not ignored but
 *    rejected, failing the whole save:
 *
 *      REJECTED : record.retain.days
 *      ACCEPTED : record.continuous.days
 *      ACCEPTED : record.alerts.retain.days
 *
 * The windows Frigate's own `record/cleanup.py` expires against are
 * `record.continuous.days`, `record.motion.days`,
 * `record.alerts.retain.days` and `record.detections.retain.days`.
 * `snapshots.retain.default` is unchanged in 0.17 and stays valid.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parse } from "yaml";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000" },
}));

const fetchConfigMock = vi.fn();
const fetchRawConfigYamlMock = vi.fn();
const saveRawConfigMock = vi.fn();

vi.mock("./frigate.client.js", () => ({
  fetchConfig: () => fetchConfigMock(),
  fetchRawConfigYaml: () => fetchRawConfigYamlMock(),
  saveRawConfig: (yamlText: string) => saveRawConfigMock(yamlText),
}));

import {
  getCameraSettings,
  updateCameraSettings,
} from "./camera-settings.service.js";

/**
 * The AUTHORED config — what `/api/config/raw` serves. Note `front_door`
 * carries a legacy `record.retain` block, as a box provisioned before this
 * fix would, and `hallway` is a second camera that must survive untouched.
 */
const AUTHORED_YAML = `mqtt:
  enabled: true
record:
  enabled: true
  alerts:
    retain:
      days: 14
      mode: motion
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://front
          roles: [detect, record]
    detect:
      enabled: true
      fps: 5
    record:
      enabled: true
      retain:
        days: 99
      continuous:
        days: 7
      alerts:
        retain:
          days: 30
          mode: motion
    snapshots:
      enabled: true
      retain:
        default: 10
  hallway:
    ffmpeg:
      inputs:
        - path: rtsp://hall
    record:
      enabled: true
      retain:
        days: 5
`;

/** The RESOLVED tree — what `/api/config` serves, used for reads only. */
function resolvedConfig() {
  return {
    objects: { filters: {} },
    cameras: {
      front_door: {
        detect: { enabled: true, fps: 5 },
        objects: { track: ["person"] },
        record: {
          enabled: true,
          continuous: { days: 7 },
          motion: { days: 14 },
          alerts: { retain: { days: 30, mode: "motion" } },
          detections: { retain: { days: 21, mode: "motion" } },
        },
        snapshots: { enabled: true, retain: { default: 10 } },
      },
    },
  };
}

/** Parse whatever YAML was handed to saveRawConfig. */
function saved(): any {
  expect(saveRawConfigMock).toHaveBeenCalled();
  return parse(saveRawConfigMock.mock.calls.at(-1)![0]);
}

beforeEach(() => {
  fetchConfigMock.mockReset().mockImplementation(async () => resolvedConfig());
  fetchRawConfigYamlMock.mockReset().mockImplementation(async () => AUTHORED_YAML);
  saveRawConfigMock
    .mockReset()
    .mockImplementation(async () => ({ ok: true, status: 200, text: async () => "" }));
});

describe("reads report what Frigate actually enforces", () => {
  it("surfaces all four retention windows from the resolved config", async () => {
    const s = await getCameraSettings("front_door");

    expect(s.continuousRetainDays).toBe(7);
    expect(s.motionRetainDays).toBe(14);
    expect(s.alertsRetainDays).toBe(30);
    expect(s.detectionsRetainDays).toBe(21);
    expect(s.snapshotRetainDays).toBe(10);
  });

  it("ignores a legacy record.retain value rather than showing a lie", async () => {
    // Frigate 0.17 does not honour this key, so reporting 99 would promise
    // the operator a retention the appliance will never deliver.
    fetchConfigMock.mockImplementation(async () => ({
      cameras: {
        front_door: { record: { enabled: true, retain: { days: 99 } } },
      },
    }));

    const s = await getCameraSettings("front_door");
    expect(s.continuousRetainDays).toBe(0);
    expect(s.continuousRetainDays).not.toBe(99);
  });
});

describe("writes go through the authored yaml, never the resolved tree", () => {
  it("saves from /api/config/raw and does not read the resolved config", async () => {
    await updateCameraSettings("front_door", { detectFps: 8 });

    expect(fetchRawConfigYamlMock).toHaveBeenCalled();
    // The resolved tree is only consulted for the post-save read-back.
    expect(saved().cameras.front_door.detect.fps).toBe(8);
  });

  it("preserves non-camera config and sibling cameras", async () => {
    await updateCameraSettings("front_door", { detectFps: 8 });

    const out = saved();
    expect(out.mqtt.enabled).toBe(true);
    expect(out.record.alerts.retain.days).toBe(14);
    expect(out.cameras.hallway.ffmpeg.inputs[0].path).toBe("rtsp://hall");
  });
});

describe("retention writes target the keys Frigate 0.17 expires against", () => {
  it("writes continuous retention to record.continuous.days", async () => {
    await updateCameraSettings("front_door", { continuousRetainDays: 30 });
    expect(saved().cameras.front_door.record.continuous.days).toBe(30);
  });

  it("writes motion retention to record.motion.days", async () => {
    await updateCameraSettings("front_door", { motionRetainDays: 3 });
    expect(saved().cameras.front_door.record.motion.days).toBe(3);
  });

  it("writes alerts + detections retention under their own retain blocks", async () => {
    await updateCameraSettings("front_door", {
      alertsRetainDays: 45,
      detectionsRetainDays: 5,
    });

    const rec = saved().cameras.front_door.record;
    expect(rec.alerts.retain.days).toBe(45);
    expect(rec.detections.retain.days).toBe(5);
    // `mode` is a sibling of `days` — editing retention must not drop it.
    expect(rec.alerts.retain.mode).toBe("motion");
  });

  it("keeps snapshot retention on snapshots.retain.default", async () => {
    await updateCameraSettings("front_door", { snapshotRetainDays: 20 });
    expect(saved().cameras.front_door.snapshots.retain.default).toBe(20);
  });

  it("never emits record.retain — on any camera, for any edit", async () => {
    // The edit here is unrelated to retention: a stale legacy key would
    // still sink this save, so it is stripped from every camera.
    await updateCameraSettings("front_door", { detectFps: 8 });

    const cams = saved().cameras;
    expect(cams.front_door.record).not.toHaveProperty("retain");
    expect(cams.hallway.record).not.toHaveProperty("retain");
    expect(saveRawConfigMock.mock.calls.at(-1)![0]).not.toContain("retain:\n        days: 99");
  });

  it("rejects an out-of-range window without saving anything", async () => {
    await expect(
      updateCameraSettings("front_door", { continuousRetainDays: 400 }),
    ).rejects.toThrow(/between 0 and 365/);

    expect(saveRawConfigMock).not.toHaveBeenCalled();
  });

  it("surfaces a Frigate rejection instead of reporting success", async () => {
    saveRawConfigMock.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => "validation error",
    }));

    await expect(
      updateCameraSettings("front_door", { continuousRetainDays: 30 }),
    ).rejects.toThrow(/Frigate rejected the config: 400/);
  });
});

describe("zone + mask edits still round-trip", () => {
  it("replaces zones wholesale rather than merging", async () => {
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    zones:
      old_zone:
        coordinates: "0.1,0.1,0.9,0.1,0.9,0.9"
        inertia: 3
`,
    );

    await updateCameraSettings("front_door", {
      zones: [
        { name: "new_zone", coordinates: [0.2, 0.2, 0.8, 0.2, 0.8, 0.8], objects: ["person"], inertia: 4 },
      ],
    });

    const zones = saved().cameras.front_door.zones;
    expect(Object.keys(zones)).toEqual(["new_zone"]);
    expect(zones.new_zone.coordinates).toBe("0.2,0.2,0.8,0.2,0.8,0.8");
    expect(zones.new_zone.objects).toEqual(["person"]);
  });

  it("clears zones when handed an empty list", async () => {
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    zones:
      old_zone:
        coordinates: "0.1,0.1,0.9,0.1,0.9,0.9"
        inertia: 3
`,
    );

    await updateCameraSettings("front_door", { zones: [] });
    expect(saved().cameras.front_door).not.toHaveProperty("zones");
  });

  it("rejects a degenerate polygon without saving", async () => {
    await expect(
      updateCameraSettings("front_door", {
        zones: [{ name: "bad", coordinates: [0.1, 0.2], objects: [], inertia: 3 }],
      }),
    ).rejects.toThrow(/at least 3/);

    expect(saveRawConfigMock).not.toHaveBeenCalled();
  });
});

describe("unknown camera", () => {
  it("throws instead of writing a new camera block", async () => {
    await expect(
      updateCameraSettings("nonexistent", { detectFps: 8 }),
    ).rejects.toThrow(/not found/);

    expect(saveRawConfigMock).not.toHaveBeenCalled();
  });
});

describe("the save never reads back from a restarting Frigate", () => {
  it("returns the projected state without a post-save config read", async () => {
    // /api/config/save?save_option=restart makes Frigate reload. A GET
    // straight after is answered by the pre-restart process (stale) or
    // refused (turning a save that LANDED into a 500). So exactly one
    // config read is allowed, and it must happen before the write.
    await updateCameraSettings("front_door", { continuousRetainDays: 7 });

    expect(fetchConfigMock).toHaveBeenCalledTimes(1);
  });

  it("reports the value the operator just set, not the pre-save one", async () => {
    // The fixture's resolved config says continuous = 7. If the function
    // read back from the restarting process it would return 7 and the
    // dashboard would snap the slider back.
    const result = await updateCameraSettings("front_door", {
      continuousRetainDays: 30,
    });

    expect(result.continuousRetainDays).toBe(30);
  });

  it("still surfaces a Frigate rejection rather than a projection", async () => {
    saveRawConfigMock.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => "validation error",
    }));

    await expect(
      updateCameraSettings("front_door", { continuousRetainDays: 30 }),
    ).rejects.toThrow(/Frigate rejected the config: 400/);
  });

  it("carries unpatched fields through untouched", async () => {
    const result = await updateCameraSettings("front_door", { detectFps: 8 });

    expect(result.detectFps).toBe(8);
    expect(result.alertsRetainDays).toBe(30); // from the fixture
    expect(result.snapshotRetainDays).toBe(10);
  });
});

describe("clearing motion masks on a camera with no motion block", () => {
  it("does not throw — deleteIn rejects a missing intermediate node", async () => {
    // addCamera authors ffmpeg/detect/record/snapshots and no `motion:`
    // key, so this is the shape of EVERY appliance-provisioned camera.
    // yaml's deleteIn throws "Expected YAML collection at motion" here.
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    detect:
      enabled: true
`,
    );

    await expect(
      updateCameraSettings("front_door", { motionMasks: [] }),
    ).resolves.toBeDefined();

    expect(saveRawConfigMock).toHaveBeenCalled();
  });

  it("still removes an existing mask", async () => {
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    motion:
      threshold: 30
      mask:
        - "0.1,0.1,0.9,0.1,0.9,0.9"
`,
    );

    await updateCameraSettings("front_door", { motionMasks: [] });

    const cam = saved().cameras.front_door;
    expect(cam.motion).not.toHaveProperty("mask");
    // A sibling under motion must survive the mask removal.
    expect(cam.motion.threshold).toBe(30);
  });
});

describe("zone edits preserve fields the dashboard doesn't model", () => {
  it("keeps loitering_time / speed_threshold on an edited zone", async () => {
    // getCameraSettings models only coordinates/objects/inertia. Rebuilding
    // the zones block from that reduced shape would delete every other
    // Frigate 0.17 ZoneConfig field the operator authored by hand.
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    zones:
      driveway:
        coordinates: "0.1,0.1,0.9,0.1,0.9,0.9"
        inertia: 3
        loitering_time: 12
        speed_threshold: 4
`,
    );

    await updateCameraSettings("front_door", {
      zones: [
        {
          name: "driveway",
          coordinates: [0.2, 0.2, 0.8, 0.2, 0.8, 0.8],
          objects: ["person"],
          inertia: 5,
        },
      ],
    });

    const z = saved().cameras.front_door.zones.driveway;
    expect(z.coordinates).toBe("0.2,0.2,0.8,0.2,0.8,0.8"); // updated
    expect(z.inertia).toBe(5); // updated
    expect(z.loitering_time).toBe(12); // preserved
    expect(z.speed_threshold).toBe(4); // preserved
  });

  it("still deletes a zone the operator removed", async () => {
    fetchRawConfigYamlMock.mockImplementation(
      async () => `cameras:
  front_door:
    zones:
      keep_me:
        coordinates: "0.1,0.1,0.9,0.1,0.9,0.9"
        inertia: 3
      drop_me:
        coordinates: "0.2,0.2,0.8,0.2,0.8,0.8"
        inertia: 3
        loitering_time: 9
`,
    );

    await updateCameraSettings("front_door", {
      zones: [
        { name: "keep_me", coordinates: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9], objects: [], inertia: 3 },
      ],
    });

    const zones = saved().cameras.front_door.zones;
    expect(Object.keys(zones)).toEqual(["keep_me"]);
  });
});
