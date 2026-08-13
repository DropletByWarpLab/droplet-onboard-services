/**
 * WARP-1960 — the NVR denominator.
 *
 * `LIVE_SERVICE_STORAGE` is a verbatim capture of `service.storage` from
 * `GET /api/stats` on Frigate 0.17.1 on the production box, 2026-08-13.
 * Three facts about it drive every case here:
 *
 *   1. It lives under `service`, NOT at the top level of the stats
 *      payload. Reading `stats.storage` returned {} on every request, so
 *      the Storage KPI rendered "—" and the volumes table never appeared.
 *   2. The numbers are MiB. Passed through as bytes, the 1.8 TiB array
 *      reads as "1.8 MB".
 *   3. `/media/frigate/recordings` and `/media/frigate/clips` are ONE
 *      filesystem reported twice, and `/tmp/cache` is the boot SSD.
 *      Summing all four describes no disk that exists.
 */

import { describe, it, expect } from "vitest";
import { extractStorage, recordingsVolume } from "./camera-system.service.js";

const MIB = 1024 * 1024;

/** Verbatim from the box. */
const LIVE_SERVICE_STORAGE = {
  storage: {
    "/media/frigate/recordings": {
      total: 1876558.3,
      used: 4555.5,
      free: 1776606.7,
      mount_type: "ext4",
    },
    "/media/frigate/clips": {
      total: 1876558.3,
      used: 4555.5,
      free: 1776606.7,
      mount_type: "ext4",
    },
    "/tmp/cache": {
      total: 236716.5,
      used: 107574.1,
      free: 118439.1,
      mount_type: "overlay",
    },
    "/dev/shm": {
      total: 256.0,
      used: 58.4,
      free: 197.6,
      mount_type: "tmpfs",
    },
  },
};

describe("extractStorage reads the right key", () => {
  it("finds every volume under service.storage", () => {
    expect(extractStorage(LIVE_SERVICE_STORAGE).map((s) => s.path).sort()).toEqual([
      "/dev/shm",
      "/media/frigate/clips",
      "/media/frigate/recordings",
      "/tmp/cache",
    ]);
  });

  it("returns nothing when handed the TOP-LEVEL stats object", () => {
    // The regression, stated as a test: the old code passed `stats` here
    // instead of `stats.service`, and got an empty array forever. The
    // live payload has no top-level `storage` key at all.
    expect(extractStorage(LIVE_SERVICE_STORAGE.storage ? { notService: 1 } : {})).toEqual([]);
  });
});

describe("units", () => {
  it("converts Frigate's MiB to bytes", () => {
    const rec = extractStorage(LIVE_SERVICE_STORAGE).find(
      (s) => s.path === "/media/frigate/recordings",
    )!;

    expect(rec.totalBytes).toBe(Math.round(1876558.3 * MIB));
    expect(rec.usedBytes).toBe(Math.round(4555.5 * MIB));
    expect(rec.freeBytes).toBe(Math.round(1776606.7 * MIB));
  });

  it("puts the array in the terabyte range, not the megabyte range", () => {
    const rec = recordingsVolume(extractStorage(LIVE_SERVICE_STORAGE))!;
    const tib = rec.totalBytes / 1024 ** 4;

    // Treating MiB as bytes gave 1_876_558 B ≈ 1.8 MB for a 1.8 TiB array.
    expect(tib).toBeGreaterThan(1.5);
    expect(tib).toBeLessThan(2.5);
  });
});

describe("one physical drive is counted once", () => {
  it("marks clips as a duplicate of recordings, not a second volume", () => {
    const rows = extractStorage(LIVE_SERVICE_STORAGE);
    const clips = rows.find((s) => s.path === "/media/frigate/clips")!;
    const rec = rows.find((s) => s.path === "/media/frigate/recordings")!;

    expect(rec.duplicateOf).toBeNull();
    expect(clips.duplicateOf).toBe("/media/frigate/recordings");
  });

  it("classifies the boot cache and shm away from recordings", () => {
    const byPath = new Map(extractStorage(LIVE_SERVICE_STORAGE).map((s) => [s.path, s]));

    expect(byPath.get("/media/frigate/recordings")!.role).toBe("recordings");
    expect(byPath.get("/tmp/cache")!.role).toBe("cache");
    expect(byPath.get("/dev/shm")!.role).toBe("shm");
  });

  it("sums to the real drive, not a phantom one", () => {
    const rows = extractStorage(LIVE_SERVICE_STORAGE);
    const naive = rows.reduce((n, s) => n + s.totalBytes, 0);
    const real = recordingsVolume(rows)!.totalBytes;

    // The old KPI added all four: ~4 TB of drive that does not exist.
    expect(naive).toBeGreaterThan(real * 1.9);
    expect(real).toBe(Math.round(1876558.3 * MIB));
  });

  it("reports the true utilisation of the recordings drive", () => {
    const rec = recordingsVolume(extractStorage(LIVE_SERVICE_STORAGE))!;
    const pct = (rec.usedBytes / rec.totalBytes) * 100;

    // Measured: 4.5 GiB of 1.8 TiB. The summed version folded in a boot
    // SSD that was 45% full and reported ~3%.
    expect(pct).toBeGreaterThan(0.2);
    expect(pct).toBeLessThan(0.3);
  });
});

describe("recordingsVolume is honest when it cannot tell", () => {
  it("returns null rather than inventing a denominator", () => {
    // A fabricated total would make a full drive look roomy.
    expect(recordingsVolume([])).toBeNull();
  });

  it("falls back to the single real volume on an unusual layout", () => {
    const rows = extractStorage({
      storage: { "/data": { total: 1000, used: 100, free: 900, mount_type: "ext4" } },
    });
    expect(recordingsVolume(rows)?.path).toBe("/data");
  });

  it("prefers the recordings mount over clips when both are present", () => {
    expect(recordingsVolume(extractStorage(LIVE_SERVICE_STORAGE))!.path).toBe(
      "/media/frigate/recordings",
    );
  });
});
