/**
 * WARP-3515 — what a drive object says about its encryption and its job.
 *
 * WARP-3513 adds `encryption`, `preparation`, `usage` and `isSystemDisk` to the
 * drive objects. They land separately from the dashboard, so every helper here
 * has a third answer for "the orchestrator did not say": `unreported`. The UI
 * then renders nothing about encryption — it never guesses a drive is plain, and
 * above all never claims a drive is encrypted it has not been told is.
 */
import { describe, it, expect, vi } from "vitest";
import type { DriveInfo } from "@/lib/types";
import {
  canPrepareDrive,
  driveEncryptionState,
  isEncryptionReported,
  isRecordingsDrive,
  pickPreparedDrive,
  recordingsReservedBytes,
  resolveNewDriveId,
} from "./drive-encryption";

describe("driveEncryptionState", () => {
  it("is `unreported` when neither field is present (an orchestrator without WARP-3513)", () => {
    expect(driveEncryptionState({})).toBe("unreported");
  });

  it("is `encrypted` for a LUKS2 drive", () => {
    expect(driveEncryptionState({ encryption: "luks2", preparation: "prepared" })).toBe("encrypted");
    expect(driveEncryptionState({ encryption: "luks2" })).toBe("encrypted");
  });

  it("is `needs_preparing` for a plain drive — the explicit preparation enum wins", () => {
    expect(driveEncryptionState({ encryption: "none", preparation: "needs_preparing" })).toBe(
      "needs_preparing",
    );
    expect(driveEncryptionState({ preparation: "needs_preparing" })).toBe("needs_preparing");
    // Even if `encryption` were somehow stale, needs_preparing is authoritative.
    expect(driveEncryptionState({ encryption: "luks2", preparation: "needs_preparing" })).toBe(
      "needs_preparing",
    );
  });

  it("treats encryption:none with no preparation field as needing preparation", () => {
    expect(driveEncryptionState({ encryption: "none" })).toBe("needs_preparing");
  });

  it("is `unknown` when the orchestrator could not tell", () => {
    expect(driveEncryptionState({ encryption: "unknown" })).toBe("unknown");
  });

  it("never claims `encrypted` on contradictory data (prepared but encryption none)", () => {
    expect(driveEncryptionState({ encryption: "none", preparation: "prepared" })).toBe("unknown");
  });

  it("trusts an explicit `prepared` when encryption is unknown", () => {
    expect(driveEncryptionState({ encryption: "unknown", preparation: "prepared" })).toBe("encrypted");
  });
});

describe("isEncryptionReported", () => {
  it("is false for an empty list and for drives that carry neither field", () => {
    expect(isEncryptionReported([])).toBe(false);
    expect(isEncryptionReported([{}, {}])).toBe(false);
  });

  it("is true as soon as any drive carries either field", () => {
    expect(isEncryptionReported([{}, { encryption: "none" }])).toBe(true);
    expect(isEncryptionReported([{ preparation: "prepared" }])).toBe(true);
  });
});

describe("isRecordingsDrive / recordingsReservedBytes", () => {
  it("is true only for usage.role === recordings", () => {
    expect(isRecordingsDrive({ usage: { role: "recordings", reservedBytes: 5 } })).toBe(true);
    expect(isRecordingsDrive({ usage: { role: "files", reservedBytes: null } })).toBe(false);
    expect(isRecordingsDrive({ usage: { role: null, reservedBytes: null } })).toBe(false);
    expect(isRecordingsDrive({ usage: null })).toBe(false);
    expect(isRecordingsDrive({})).toBe(false);
  });

  it("returns the reservation only for a recordings drive that has one", () => {
    expect(recordingsReservedBytes({ usage: { role: "recordings", reservedBytes: 128 } })).toBe(128);
    expect(recordingsReservedBytes({ usage: { role: "recordings", reservedBytes: null } })).toBeNull();
    expect(recordingsReservedBytes({ usage: { role: "files", reservedBytes: 128 } })).toBeNull();
    expect(recordingsReservedBytes({})).toBeNull();
  });
});

describe("canPrepareDrive — the gate on the Prepare drive action", () => {
  const plain = { encryption: "none" as const, preparation: "needs_preparing" as const };

  it("offers it for a plain, standalone data drive on a recognisable whole disk", () => {
    expect(canPrepareDrive({ ...plain, device: "/dev/sdb1" }, "sdb")).toBe(true);
  });

  it("never offers it on an already-encrypted drive", () => {
    expect(
      canPrepareDrive({ encryption: "luks2", preparation: "prepared", device: "/dev/sdb1" }, "sdb"),
    ).toBe(false);
  });

  it("never offers it when the orchestrator did not report encryption (older backend)", () => {
    expect(canPrepareDrive({ device: "/dev/sdb1" }, "sdb")).toBe(false);
  });

  it("never offers it on the system disk", () => {
    expect(canPrepareDrive({ ...plain, isSystemDisk: true, device: "/dev/nvme0n1p2" }, "nvme0n1")).toBe(
      false,
    );
  });

  it("never offers it on the active recordings drive", () => {
    expect(
      canPrepareDrive(
        { ...plain, usage: { role: "recordings", reservedBytes: 1 }, device: "/dev/sdb1" },
        "sdb",
      ),
    ).toBe(false);
  });

  it("never offers it on a pool-backed volume (a pool is prepared from its own card)", () => {
    expect(canPrepareDrive({ ...plain, device: "/dev/md127", pool: "md127" }, "")).toBe(false);
    expect(canPrepareDrive({ ...plain, device: "/dev/md127" }, "sdb")).toBe(false);
  });

  it("never offers it without a whole-disk name the host script can act on", () => {
    expect(canPrepareDrive({ ...plain, device: "/dev/mapper/x" }, "")).toBe(false);
  });
});

function drive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/mapper/droplet-bay-1",
    mount: "/mnt/droplet/x",
    label: "",
    uuid: "U-1",
    size_bytes: 1,
    used_bytes: 0,
    free_bytes: 1,
    mounted: true,
    encryption: "luks2",
    preparation: "prepared",
    ...overrides,
  };
}

describe("pickPreparedDrive — finding the drive a Prepare just created", () => {
  const none = new Set<string>();

  it("prefers the encrypted drive on the disk that was prepared", () => {
    const hit = drive({ uuid: "U-NEW", parent_disk: "sdb" });
    const other = drive({ uuid: "U-OLD", parent_disk: "sdc" });
    expect(
      pickPreparedDrive([other, hit], { diskName: "sdb", knownUuids: new Set(["U-OLD"]) }),
    ).toBe(hit);
  });

  it("falls back to the one NEW encrypted drive when the bridge reports no parent disk", () => {
    const fresh = drive({ uuid: "U-NEW", parent_disk: undefined });
    const old = drive({ uuid: "U-OLD" });
    expect(
      pickPreparedDrive([old, fresh], { diskName: "sdb", knownUuids: new Set(["U-OLD"]) }),
    ).toBe(fresh);
  });

  it("will not guess between several new encrypted drives", () => {
    const a = drive({ uuid: "U-A" });
    const b = drive({ uuid: "U-B" });
    expect(pickPreparedDrive([a, b], { diskName: "sdb", knownUuids: none })).toBeUndefined();
  });

  it("ignores plain drives and drives with no id", () => {
    expect(
      pickPreparedDrive(
        [
          drive({ encryption: "none", preparation: "needs_preparing", uuid: "U-1", parent_disk: "sdb" }),
          drive({ uuid: "", parent_disk: "sdb" }),
        ],
        { diskName: "sdb", knownUuids: none },
      ),
    ).toBeUndefined();
  });

  it("finds the filesystem backing a freshly formatted pool by its array name", () => {
    const hit = drive({ uuid: "U-POOL", device: "/dev/md127", pool: "md127" });
    expect(
      pickPreparedDrive([drive({ uuid: "U-X", parent_disk: "sdz" }), hit], {
        poolDevice: "md127",
        knownUuids: none,
      }),
    ).toBe(hit);
  });

  it("returns undefined when nothing has appeared yet", () => {
    expect(pickPreparedDrive([], { diskName: "sdb", knownUuids: none })).toBeUndefined();
  });

  it("never substitutes a newly attached drive that explicitly belongs to another disk", () => {
    expect(
      pickPreparedDrive([drive({ uuid: "U-OTHER", parent_disk: "sdc" })], {
        diskName: "sdb",
        knownUuids: none,
      }),
    ).toBeUndefined();
  });

  it("never substitutes a filesystem from another pool", () => {
    expect(
      pickPreparedDrive([drive({ uuid: "U-OTHER", pool: "md126", device: "/dev/md126" })], {
        poolDevice: "md127",
        knownUuids: none,
      }),
    ).toBeUndefined();
  });

  it("waits for the new filesystem when a stale exact-source UUID is still listed", () => {
    expect(
      pickPreparedDrive([drive({ uuid: "U-OLD", pool: "md127", device: "/dev/md127" })], {
        poolDevice: "md127",
        knownUuids: new Set(["U-OLD"]),
      }),
    ).toBeUndefined();
  });

  it("will not guess between two new filesystems that both identify the requested disk", () => {
    expect(
      pickPreparedDrive([
        drive({ uuid: "U-A", parent_disk: "sdb" }),
        drive({ uuid: "U-B", parent_disk: "sdb" }),
      ], { diskName: "sdb", knownUuids: none }),
    ).toBeUndefined();
  });

  it("does not treat an explicitly identified standalone disk as an unidentified pool result", () => {
    expect(
      pickPreparedDrive([drive({ uuid: "U-OTHER", parent_disk: "sdc" })], {
        poolDevice: "md127",
        knownUuids: none,
      }),
    ).toBeUndefined();
  });
});

describe("resolveNewDriveId — the drive list can lag the host by a few seconds", () => {
  const hit = drive({ uuid: "U-NEW", parent_disk: "sdb" });
  const pick = (ds: DriveInfo[]) => ds.find((d) => d.parent_disk === "sdb");
  const noWait = async () => {};

  it("returns the id as soon as the refreshed list has the drive", async () => {
    const refresh = vi.fn().mockResolvedValue({ drives: [hit] });
    await expect(
      resolveNewDriveId({ refresh, pick, current: () => [], attempts: 3, delayMs: 5, sleep: noWait }),
    ).resolves.toBe("U-NEW");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retries, waiting between attempts, until the drive shows up", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ drives: [] })
      .mockResolvedValueOnce({ drives: [] })
      .mockResolvedValueOnce({ drives: [hit] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveNewDriveId({ refresh, pick, current: () => [], attempts: 3, delayMs: 7, sleep }),
    ).resolves.toBe("U-NEW");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
  });

  it("gives up with null after the last attempt, and does not sleep after it", async () => {
    const refresh = vi.fn().mockResolvedValue({ drives: [] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveNewDriveId({ refresh, pick, current: () => [], attempts: 3, delayMs: 5, sleep }),
    ).resolves.toBeNull();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("falls back to the panel's current list when a refresh returns nothing", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    await expect(
      resolveNewDriveId({ refresh, pick, current: () => [hit], attempts: 1, delayMs: 0, sleep: noWait }),
    ).resolves.toBe("U-NEW");
  });

  it("stops polling the moment it is cancelled", async () => {
    const refresh = vi.fn().mockResolvedValue({ drives: [] });
    let cancelled = false;
    const sleep = vi.fn(async () => {
      cancelled = true;
    });
    await expect(
      resolveNewDriveId({
        refresh,
        pick,
        current: () => [],
        attempts: 5,
        delayMs: 1,
        sleep,
        isCancelled: () => cancelled,
      }),
    ).resolves.toBeNull();
    // One attempt ran; the cancellation after its sleep ended the loop.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("treats a failing refresh as 'not yet' rather than throwing", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge"))
      .mockResolvedValueOnce({ drives: [hit] });
    await expect(
      resolveNewDriveId({ refresh, pick, current: () => [], attempts: 2, delayMs: 0, sleep: noWait }),
    ).resolves.toBe("U-NEW");
  });
});
