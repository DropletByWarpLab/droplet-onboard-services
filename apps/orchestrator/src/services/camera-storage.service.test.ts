/**
 * WARP-1850 — NVR storage accounting.
 *
 * The shape assertions here come from Frigate 0.17.1's `storage.py` rather
 * than its docs, because two details are easy to get wrong and both fail
 * silently:
 *
 *   - `/api/recordings/storage` is keyed by `friendly_name` when a camera
 *     sets one, else the camera name. Assuming camera names drops those
 *     cameras from the breakdown with no error.
 *   - `usage` is `null` (SQL SUM over zero rows) for a camera that has
 *     recorded nothing. Coercing it to 0 tells the operator a camera uses
 *     no space when the truth is we don't know yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000" },
}));

const fetchStatsMock = vi.fn();
const fetchRecordingsStorageMock = vi.fn();
const fetchConfigMock = vi.fn();

const recordActivityMock = vi.fn();
vi.mock("./activity.singleton.js", () => ({
  recordActivity: (row: unknown) => recordActivityMock(row),
}));

vi.mock("./frigate.client.js", () => ({
  fetchStats: () => fetchStatsMock(),
  fetchRecordingsStorage: () => fetchRecordingsStorageMock(),
  fetchConfig: () => fetchConfigMock(),
}));

import {
  getCameraStorage,
  checkStorageNearFull,
  __resetNearFullState,
  NEAR_FULL_RATIO,
} from "./camera-storage.service.js";

const MIB = 1024 * 1024;

/** 1000 GiB volume, 100 GiB used. Frigate reports MiB. */
function stats(usedMib = 100 * 1024, totalMib = 1000 * 1024) {
  return {
    service: {
      storage: {
        "/media/frigate/recordings": {
          total: totalMib,
          used: usedMib,
          free: totalMib - usedMib,
          mount_type: "ext4",
        },
      },
    },
  };
}

beforeEach(() => {
  recordActivityMock.mockReset();
  __resetNearFullState();
  fetchStatsMock.mockReset().mockImplementation(async () => stats());
  fetchRecordingsStorageMock.mockReset().mockImplementation(async () => ({
    front_door: { usage: 60 * 1024, bandwidth: 500 },
    hallway: { usage: 40 * 1024, bandwidth: 250 },
  }));
  fetchConfigMock.mockReset().mockImplementation(async () => ({
    cameras: { front_door: {}, hallway: {} },
  }));
});

describe("per-camera breakdown", () => {
  it("converts Frigate's MiB to bytes and ranks the biggest consumer first", async () => {
    const s = await getCameraStorage();

    expect(s.cameras.map((c) => c.camera)).toEqual(["front_door", "hallway"]);
    expect(s.cameras[0].usedBytes).toBe(60 * 1024 * MIB);
    expect(s.cameras[0].bytesPerHour).toBe(500 * MIB);
  });

  it("computes each camera's share of the volume", async () => {
    const s = await getCameraStorage();

    // 60 GiB of a 1000 GiB volume.
    expect(s.cameras[0].sharePercent).toBe(6);
    expect(s.cameras[1].sharePercent).toBe(4);
  });

  it("resolves friendly_name keys back to the real camera name", async () => {
    // Frigate keys by friendly_name when set. Without the reverse lookup
    // this camera would be reported as "Front Door" and never join to the
    // camera record.
    fetchRecordingsStorageMock.mockImplementation(async () => ({
      "Front Door": { usage: 60 * 1024, bandwidth: 500 },
    }));
    fetchConfigMock.mockImplementation(async () => ({
      cameras: { front_door: { friendly_name: "Front Door" } },
    }));

    const s = await getCameraStorage();
    expect(s.cameras[0].camera).toBe("front_door");
  });

  it("keeps a storage key that has no matching camera rather than dropping it", async () => {
    fetchConfigMock.mockImplementation(async () => ({ cameras: {} }));

    const s = await getCameraStorage();
    expect(s.cameras.map((c) => c.camera)).toContain("front_door");
  });

  it("still reports rows when the config read fails", async () => {
    fetchConfigMock.mockImplementation(async () => {
      throw new Error("config unreachable");
    });

    const s = await getCameraStorage();
    expect(s.cameras).toHaveLength(2);
  });
});

describe("unknown values stay unknown", () => {
  it("preserves null usage rather than reporting zero", async () => {
    fetchRecordingsStorageMock.mockImplementation(async () => ({
      new_cam: { usage: null, bandwidth: 0 },
    }));
    fetchConfigMock.mockImplementation(async () => ({ cameras: { new_cam: {} } }));

    const s = await getCameraStorage();
    expect(s.cameras[0].usedBytes).toBeNull();
    expect(s.cameras[0].usedBytes).not.toBe(0);
  });

  it("treats a zero bitrate as unmeasured, not as free", async () => {
    fetchRecordingsStorageMock.mockImplementation(async () => ({
      new_cam: { usage: 1024, bandwidth: 0 },
    }));
    fetchConfigMock.mockImplementation(async () => ({ cameras: { new_cam: {} } }));

    const s = await getCameraStorage();
    expect(s.cameras[0].bytesPerHour).toBeNull();
    // Deriving days from a zero rate would be Infinity — never surface that.
    expect(s.cameras[0].daysAtCurrentRate).toBeNull();
  });

  it("sorts cameras with unknown usage last, not as zero", async () => {
    fetchRecordingsStorageMock.mockImplementation(async () => ({
      unknown_cam: { usage: null, bandwidth: 0 },
      small_cam: { usage: 1, bandwidth: 10 },
    }));
    fetchConfigMock.mockImplementation(async () => ({
      cameras: { unknown_cam: {}, small_cam: {} },
    }));

    const s = await getCameraStorage();
    expect(s.cameras.at(-1)!.camera).toBe("unknown_cam");
  });
});

describe("near-full warning", () => {
  it("does not warn below the threshold", async () => {
    const s = await getCameraStorage(); // 10% used
    expect(s.nearFull).toBe(false);
  });

  it("warns once the volume crosses the threshold", async () => {
    fetchStatsMock.mockImplementation(async () =>
      stats(Math.round(1000 * 1024 * (NEAR_FULL_RATIO + 0.01))),
    );

    const s = await getCameraStorage();
    expect(s.nearFull).toBe(true);
  });

  it("reports the combined fill rate across cameras", async () => {
    const s = await getCameraStorage();
    expect(s.totalBytesPerHour).toBe(750 * MIB);
  });
});

describe("degraded Frigate", () => {
  it("throws rather than reporting an empty, healthy-looking picture", async () => {
    fetchRecordingsStorageMock.mockImplementation(async () => {
      throw new Error("Frigate recordings storage: 502");
    });

    await expect(getCameraStorage()).rejects.toThrow(/502/);
  });

  it("reports no volume rather than a fabricated one when stats are empty", async () => {
    fetchStatsMock.mockImplementation(async () => ({ service: { storage: {} } }));

    const s = await getCameraStorage();
    expect(s.volume).toBeNull();
    expect(s.nearFull).toBe(false);
    // Share is uncomputable without a volume — must not be invented.
    expect(s.cameras[0].sharePercent).toBeNull();
  });

  it("returns an empty breakdown when no cameras are configured", async () => {
    fetchRecordingsStorageMock.mockImplementation(async () => ({}));

    const s = await getCameraStorage();
    expect(s.cameras).toEqual([]);
    expect(s.totalBytesPerHour).toBeNull();
  });
});

describe("near-full warning is edge-triggered", () => {
  /** Volume at `pct` percent full. */
  function atPercent(pct: number) {
    fetchStatsMock.mockImplementation(async () =>
      stats(Math.round(1000 * 1024 * (pct / 100))),
    );
  }

  it("stays quiet while the volume is healthy", async () => {
    atPercent(10);
    const r = await checkStorageNearFull();

    expect(r.warned).toBe(false);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("warns once on the crossing, then stays quiet while still full", async () => {
    atPercent(90);

    const first = await checkStorageNearFull();
    expect(first.warned).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);

    // Three more ticks at the same level — an operator must not get an
    // hourly repeat of a warning they have already seen.
    await checkStorageNearFull();
    await checkStorageNearFull();
    await checkStorageNearFull();
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the volume recovers, and warns again on the next crossing", async () => {
    atPercent(90);
    await checkStorageNearFull();
    expect(recordActivityMock).toHaveBeenCalledTimes(1);

    atPercent(20);
    await checkStorageNearFull();

    atPercent(90);
    const again = await checkStorageNearFull();
    expect(again.warned).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
  });

  it("names the biggest consumer so the warning is actionable", async () => {
    atPercent(90);
    await checkStorageNearFull();

    const row = recordActivityMock.mock.calls[0][0];
    // "warn", not "warning" — ActivitySeverityName is "ok"|"warn"|"err"|"info".
    // Asserting the literal here is what keeps the mocked recordActivity from
    // hiding a contract mismatch the way it did on the first pass.
    expect(row.severity).toBe("warn");
    expect(row.refs.largestCamera).toBe("front_door");
    expect(row.refs.thresholdPercent).toBe(NEAR_FULL_RATIO * 100);
  });

  it("throws on an unreachable Frigate and does not consume the crossing", async () => {
    atPercent(90);
    fetchRecordingsStorageMock.mockImplementation(async () => {
      throw new Error("Frigate recordings storage: 502");
    });

    await expect(checkStorageNearFull()).rejects.toThrow(/502/);
    expect(recordActivityMock).not.toHaveBeenCalled();

    // The outage must not have swallowed the transition: once Frigate is
    // back, the crossing still warns.
    fetchRecordingsStorageMock.mockImplementation(async () => ({
      front_door: { usage: 60 * 1024, bandwidth: 500 },
    }));
    const recovered = await checkStorageNearFull();
    expect(recovered.warned).toBe(true);
  });
});
