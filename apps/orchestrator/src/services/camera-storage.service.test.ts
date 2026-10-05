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
  getCameraStorageSnapshot,
  checkStorageNearFull,
  __resetNearFullState,
  NEAR_FULL_RATIO,
} from "./camera-storage.service.js";
import { GROW_TRIGGER_RATIO } from "./recordings-sizing.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

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

  it("marks resolved retention unknown when config fails while preserving the storage view", async () => {
    fetchConfigMock.mockRejectedValueOnce(new Error("config unreachable"));
    const snapshot = await getCameraStorageSnapshot();
    expect(snapshot.storage.cameras).toHaveLength(2);
    expect(snapshot.effectiveRetentionByCamera).toBeNull();
  });

  it("does not treat a partial resolved record block as allocation-grade retention", async () => {
    fetchConfigMock.mockResolvedValueOnce({
      cameras: { front_door: { record: { continuous: { days: 90 } } }, hallway: {} },
    });
    const snapshot = await getCameraStorageSnapshot();
    expect(snapshot.storage.cameras).toHaveLength(2);
    expect(snapshot.effectiveRetentionByCamera).toEqual({});
  });

  it("keeps prototype-named cameras as own entries and does not inherit phantom policies", async () => {
    const cameras = Object.fromEntries([
      ["__proto__", { record: {
        continuous: { days: 90 },
        motion: { days: 0 },
        alerts: { retain: { days: 0 } },
        detections: { retain: { days: 0 } },
      } }],
      ["toString", {}],
    ]);
    fetchConfigMock.mockResolvedValueOnce({ cameras });

    const snapshot = await getCameraStorageSnapshot();
    const policies = snapshot.effectiveRetentionByCamera!;

    expect(Object.getPrototypeOf(policies)).toBeNull();
    expect(Object.hasOwn(policies, "__proto__")).toBe(true);
    expect(policies["__proto__"]).toMatchObject({ continuousDays: 90 });
    expect(Object.hasOwn(policies, "toString")).toBe(false);
    expect(policies.toString).toBeUndefined();
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

/**
 * WARP-3514 / ADR-070 — near-full against the RECORDINGS RESERVATION.
 *
 * With the allocation in place Frigate's own `volume.totalBytes` already equals
 * the project quota (the slice looks like a smaller drive), so a quota'd box
 * agrees with the plain check. The reservation matters while the quota is not
 * live yet (the row is PENDING/MIGRATING and Frigate still sees the whole
 * filesystem) and as a ceiling that can never be LOWER than reality: the
 * capacity is `min(reserved, volume total)`. With no reservation supplied the
 * behaviour above is untouched — those tests are the byte-identical guarantee.
 */
describe("near-full against the recordings reservation (WARP-3514)", () => {
  /** The 1000 GiB volume with `gib` GiB used. */
  function usedGib(gib: number) {
    fetchStatsMock.mockImplementation(async () => stats(gib * 1024));
  }

  it("the near-full threshold is the allocator's own 85 % grow trigger — one number, two meanings", () => {
    expect(NEAR_FULL_RATIO).toBe(GROW_TRIGGER_RATIO);
  });

  it("with no reservation the summary is exactly what it always was", async () => {
    usedGib(900);
    const plain = await getCameraStorage();
    expect(plain.nearFull).toBe(true);
    expect(await getCameraStorage({})).toEqual(plain);
    expect(await getCameraStorage({ reservedBytes: null })).toEqual(plain);
    expect(await getCameraStorage({ reservedBytes: undefined })).toEqual(plain);
  });

  it("a reservation smaller than the volume is the denominator: 100 GiB of a 110 GiB slice is near full", async () => {
    usedGib(100); // 10 % of the 1000 GiB volume — not near full on its own
    expect((await getCameraStorage()).nearFull).toBe(false);
    expect((await getCameraStorage({ reservedBytes: 110 * GIB })).nearFull).toBe(true); // 90.9 % of the slice
  });

  it("plenty of reserved headroom is not near full", async () => {
    usedGib(100);
    expect((await getCameraStorage({ reservedBytes: 500 * GIB })).nearFull).toBe(false); // 20 %
  });

  it("the 85 % boundary is inclusive, measured on the reservation", async () => {
    usedGib(85);
    expect((await getCameraStorage({ reservedBytes: 100 * GIB })).nearFull).toBe(true);
    usedGib(84);
    expect((await getCameraStorage({ reservedBytes: 100 * GIB })).nearFull).toBe(false);
  });

  it("a reservation LARGER than the volume cannot raise the capacity: min() keeps the volume total", async () => {
    usedGib(900);
    expect((await getCameraStorage({ reservedBytes: 5000 * GIB })).nearFull).toBe(true);
    usedGib(100);
    expect((await getCameraStorage({ reservedBytes: 5000 * GIB })).nearFull).toBe(false);
  });

  it("a zero or negative reservation is 'no reservation'", async () => {
    usedGib(900);
    expect((await getCameraStorage({ reservedBytes: 0 })).nearFull).toBe(true);
    expect((await getCameraStorage({ reservedBytes: -1 })).nearFull).toBe(true);
    usedGib(100);
    expect((await getCameraStorage({ reservedBytes: 0 })).nearFull).toBe(false);
  });

  it("no volume reported: still not near full — never guessed from the reservation alone", async () => {
    fetchStatsMock.mockImplementation(async () => ({ service: { storage: {} } }));
    const s = await getCameraStorage({ reservedBytes: 10 * GIB });
    expect(s.volume).toBeNull();
    expect(s.nearFull).toBe(false);
  });

  it("the volume figures themselves are Frigate's, untouched by the reservation", async () => {
    usedGib(100);
    const plain = await getCameraStorage();
    const withReservation = await getCameraStorage({ reservedBytes: 110 * GIB });
    expect(withReservation.volume).toEqual(plain.volume);
    expect(withReservation.cameras).toEqual(plain.cameras);
  });

  describe("checkStorageNearFull passes the reservation through", () => {
    it("warns once when the slice crosses 85 %, even though the whole volume is only 10 % used", async () => {
      usedGib(100);

      const first = await checkStorageNearFull({ reservedBytes: 110 * GIB });
      expect(first).toEqual({ nearFull: true, warned: true });
      expect(recordActivityMock).toHaveBeenCalledTimes(1);

      // Still full on the next ticks: edge-triggered, no repeat.
      await checkStorageNearFull({ reservedBytes: 110 * GIB });
      await checkStorageNearFull({ reservedBytes: 110 * GIB });
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
    });

    it("reports the percentage that actually triggered the warning (of the reservation), not the volume's", async () => {
      usedGib(100);
      await checkStorageNearFull({ reservedBytes: 110 * GIB });

      const row = recordActivityMock.mock.calls[0][0];
      expect(row.refs.usedPercent).toBe(90.9);
      expect(row.sub).toBe("90.9% of the recording drive is in use");
      expect(row.severity).toBe("warn");
    });

    it("without a reservation the same usage does not warn (unchanged behaviour)", async () => {
      usedGib(100);
      const r = await checkStorageNearFull();
      expect(r).toEqual({ nearFull: false, warned: false });
      expect(recordActivityMock).not.toHaveBeenCalled();
    });

    it("without a reservation the wording and figures are exactly the volume's", async () => {
      usedGib(900);
      await checkStorageNearFull();
      const row = recordActivityMock.mock.calls[0][0];
      expect(row.refs.usedPercent).toBe(90);
      expect(row.sub).toBe("90% of the recording drive is in use");
    });

    it("re-arms after the slice recovers, and warns again on the next crossing", async () => {
      usedGib(100);
      await checkStorageNearFull({ reservedBytes: 110 * GIB });
      usedGib(20);
      await checkStorageNearFull({ reservedBytes: 110 * GIB });
      usedGib(100);
      const again = await checkStorageNearFull({ reservedBytes: 110 * GIB });
      expect(again.warned).toBe(true);
      expect(recordActivityMock).toHaveBeenCalledTimes(2);
    });

    it("an unreachable Frigate still throws (the cron canary) and does not consume the crossing", async () => {
      usedGib(100);
      fetchRecordingsStorageMock.mockImplementation(async () => {
        throw new Error("Frigate recordings storage: 502");
      });
      await expect(checkStorageNearFull({ reservedBytes: 110 * GIB })).rejects.toThrow(/502/);
      expect(recordActivityMock).not.toHaveBeenCalled();
    });
  });
});
