/**
 * WARP-1963 — is footage landing on the boot disk?
 *
 * `docker-compose.yml` mounts `${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate`
 * and nothing validates the target. An unset variable, an empty one, or a
 * path whose filesystem failed to mount are all silently absorbed: Docker
 * falls back to the `nvrdata` named volume on the system disk and Frigate
 * records there quite happily.
 *
 * This box lost a month to exactly that. Its 2×2 TB RAID1 sat empty and
 * unmounted while `/` climbed to 94%, because three `/etc/fstab` entries
 * pointed at UUIDs that no longer existed and every one carried `nofail` —
 * so boot succeeded, nothing logged, and `df` simply never showed them.
 *
 * The orchestrator can't stat the path (it doesn't mount the volume, by
 * design). It doesn't need to: `/tmp/cache` is always on the container's own
 * filesystem, so if the recordings mount reports the same totals as the
 * cache mount, they are one disk.
 */

import { describe, it, expect } from "vitest";
import { extractStorage, recordingsOnBootDisk } from "./camera-system.service.js";

/** Verbatim from the production box — a correctly-mounted 1.8 TiB RAID1. */
const HEALTHY = {
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
    "/dev/shm": { total: 256.0, used: 58.4, free: 197.6, mount_type: "tmpfs" },
  },
};

/**
 * The same box after the mount fell through: `/media/frigate` is now the
 * named volume, which lives on the boot filesystem — so it reports the
 * boot disk's numbers, identical to the cache mount.
 */
const FELL_BACK = {
  storage: {
    "/media/frigate/recordings": {
      total: 236716.5,
      used: 107574.1,
      free: 118439.1,
      mount_type: "overlay",
    },
    "/media/frigate/clips": {
      total: 236716.5,
      used: 107574.1,
      free: 118439.1,
      mount_type: "overlay",
    },
    "/tmp/cache": {
      total: 236716.5,
      used: 107574.1,
      free: 118439.1,
      mount_type: "overlay",
    },
    "/dev/shm": { total: 256.0, used: 58.4, free: 197.6, mount_type: "tmpfs" },
  },
};

describe("recordingsOnBootDisk", () => {
  it("is false when recordings live on their own drive", () => {
    expect(recordingsOnBootDisk(extractStorage(HEALTHY))).toBe(false);
  });

  it("is TRUE when the NVR mount has fallen back to the boot disk", () => {
    // The month-long silent failure, caught in one comparison.
    expect(recordingsOnBootDisk(extractStorage(FELL_BACK))).toBe(true);
  });

  it("reports unknown rather than guessing when there is no cache mount", () => {
    // A false "all clear" here would be the exact failure being fixed, so
    // "can't tell" must stay distinguishable from "fine".
    const noCache = {
      storage: {
        "/media/frigate/recordings": {
          total: 1876558.3,
          used: 4555.5,
          free: 1776606.7,
          mount_type: "ext4",
        },
      },
    };
    expect(recordingsOnBootDisk(extractStorage(noCache))).toBeNull();
  });

  it("reports unknown when Frigate reports nothing at all", () => {
    expect(recordingsOnBootDisk(extractStorage({}))).toBeNull();
  });

  it("does not mistake a same-SIZE-but-different disk for the boot disk", () => {
    // Two genuinely distinct drives of the same model would share a total,
    // so the check requires free space to match too — a recordings drive
    // in real use never has byte-identical free space with the boot disk.
    const twins = {
      storage: {
        "/media/frigate/recordings": {
          total: 236716.5,
          used: 4555.5,
          free: 231000.0,
          mount_type: "ext4",
        },
        "/tmp/cache": {
          total: 236716.5,
          used: 107574.1,
          free: 118439.1,
          mount_type: "overlay",
        },
      },
    };
    expect(recordingsOnBootDisk(extractStorage(twins))).toBe(false);
  });

  it("ignores the duplicate clips row when picking the recordings mount", () => {
    // `clips` and `recordings` are one filesystem reported twice; the check
    // must compare the representative row, not whichever came first.
    const rows = extractStorage(HEALTHY);
    expect(rows.filter((r) => r.role === "recordings" && !r.duplicateOf)).toHaveLength(1);
    expect(recordingsOnBootDisk(rows)).toBe(false);
  });
});
