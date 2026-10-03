/**
 * WARP-3515 — what a drive object says about its encryption and its job.
 *
 * WARP-3513 adds `encryption`, `preparation`, `usage` and `isSystemDisk` to the
 * drive objects. They land separately from the dashboard, so every helper here
 * has a third answer for "the orchestrator did not say": `unreported`. The UI
 * then renders nothing about encryption — it never guesses a drive is plain, and
 * above all never claims a drive is encrypted it has not been told is.
 */
import { describe, it, expect } from "vitest";
import {
  canPrepareDrive,
  driveEncryptionState,
  isEncryptionReported,
  isRecordingsDrive,
  recordingsReservedBytes,
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
