/**
 * WARP-3514 / ADR-070 — which drives may hold camera recordings.
 *
 * The rule (owner decision 2026-10-03): ENCRYPTED AND PREPARED, mounted
 * read-write, not the OS disk, SMART not failed, ext4 (when reported), at least
 * 20 GiB free. Anything the bridge did not positively say is "unknown", and an
 * unknown is ineligible — on a box where WARP-3513's `encryption`/`preparation`
 * fields are not reported yet, every drive is ineligible and the status is
 * `no_eligible_drive`. That is the safe answer, never a guess.
 */
import { describe, expect, it } from "vitest";
import type { RecordingsDriveCandidate } from "./recordings.types.js";
import {
  MIN_RECORDINGS_FREE_BYTES,
  ineligibleReasons,
  isEligibleRecordingsDrive,
  normalizeBridgeDrive,
  pickRecordingsDrive,
} from "./recordings-eligibility.js";
import { GIB, NEED_FLOOR_BYTES } from "./recordings-sizing.js";

function candidate(over: Partial<RecordingsDriveCandidate> = {}): RecordingsDriveCandidate {
  return {
    fsUuid: "1111-aaaa",
    label: "Bay",
    model: "Acme SSD",
    sizeBytes: 1000 * GIB,
    usedBytes: 100 * GIB,
    freeBytes: 900 * GIB,
    mountPath: "/mnt/droplet/Bay-1111aaaa",
    mounted: true,
    readOnly: false,
    fsType: "ext4",
    encryption: "luks2",
    preparation: "prepared",
    isSystemDisk: false,
    smart: "PASSED",
    parentDisk: "sdb",
    ...over,
  };
}

describe("isEligibleRecordingsDrive / ineligibleReasons", () => {
  it("a mounted, writable, encrypted, prepared, healthy ext4 drive with room is eligible", () => {
    expect(ineligibleReasons(candidate())).toEqual([]);
    expect(isEligibleRecordingsDrive(candidate())).toBe(true);
  });

  it("the free-space floor is the 20 GiB sizing floor", () => {
    expect(MIN_RECORDINGS_FREE_BYTES).toBe(NEED_FLOOR_BYTES);
  });

  it.each([
    ["not_mounted", { mounted: false }],
    ["read_only", { readOnly: true }],
    ["not_encrypted", { encryption: "none" as const }],
    ["not_encrypted", { encryption: "unknown" as const }],
    ["not_prepared", { preparation: "needs_preparing" as const }],
    ["not_prepared", { preparation: "unknown" as const }],
    ["system_disk", { isSystemDisk: true }],
    ["smart_failed", { smart: "FAILED" as const }],
    ["not_ext4", { fsType: "xfs" }],
    ["not_ext4", { fsType: "vfat" }],
    ["too_small", { freeBytes: MIN_RECORDINGS_FREE_BYTES - 1 }],
    ["too_small", { freeBytes: 0 }],
  ] as const)("is ineligible with reason %s when %j", (reason, over) => {
    const d = candidate(over);
    expect(ineligibleReasons(d)).toEqual([reason]);
    expect(isEligibleRecordingsDrive(d)).toBe(false);
  });

  it("an unreported SMART verdict and an unreported filesystem type do NOT disqualify (the host re-validates ext4)", () => {
    expect(isEligibleRecordingsDrive(candidate({ smart: null }))).toBe(true);
    expect(isEligibleRecordingsDrive(candidate({ fsType: null }))).toBe(true);
    expect(isEligibleRecordingsDrive(candidate({ smart: "PASSED" }))).toBe(true);
  });

  it("exactly 20 GiB free is enough", () => {
    expect(isEligibleRecordingsDrive(candidate({ freeBytes: MIN_RECORDINGS_FREE_BYTES }))).toBe(true);
  });

  it("the filesystem type match is case-insensitive", () => {
    expect(isEligibleRecordingsDrive(candidate({ fsType: "EXT4" }))).toBe(true);
  });

  it("lists every reason, in a stable order", () => {
    const d = candidate({
      mounted: false,
      readOnly: true,
      encryption: "none",
      preparation: "needs_preparing",
      isSystemDisk: true,
      smart: "FAILED",
      fsType: "ntfs",
      freeBytes: 1,
    });
    expect(ineligibleReasons(d)).toEqual([
      "not_mounted",
      "read_only",
      "not_encrypted",
      "not_prepared",
      "system_disk",
      "smart_failed",
      "not_ext4",
      "too_small",
    ]);
  });

  it("encrypted-only is NOT enough: a drive that is LUKS2 but not 'prepared' is ineligible", () => {
    const d = candidate({ encryption: "luks2", preparation: "needs_preparing" });
    expect(ineligibleReasons(d)).toEqual(["not_prepared"]);
  });
});

describe("pickRecordingsDrive — deterministic choice among eligible drives", () => {
  const A = candidate({ fsUuid: "aaaa-0001", freeBytes: 500 * GIB, sizeBytes: 1000 * GIB });
  const B = candidate({ fsUuid: "bbbb-0002", freeBytes: 900 * GIB, sizeBytes: 1000 * GIB });
  const C = candidate({ fsUuid: "cccc-0003", freeBytes: 900 * GIB, sizeBytes: 2000 * GIB });
  const D = candidate({ fsUuid: "dddd-0004", freeBytes: 900 * GIB, sizeBytes: 2000 * GIB });

  it("none eligible (or none at all) is null", () => {
    expect(pickRecordingsDrive([])).toBeNull();
    expect(pickRecordingsDrive([candidate({ encryption: "none" }), candidate({ mounted: false })])).toBeNull();
  });

  it("prefers the drive with the most free space", () => {
    expect(pickRecordingsDrive([A, B])?.fsUuid).toBe("bbbb-0002");
  });

  it("on equal free space prefers the larger drive", () => {
    expect(pickRecordingsDrive([B, C])?.fsUuid).toBe("cccc-0003");
  });

  it("on a full tie prefers the lexicographically first fsUuid", () => {
    expect(pickRecordingsDrive([D, C])?.fsUuid).toBe("cccc-0003");
    expect(pickRecordingsDrive([C, D])?.fsUuid).toBe("cccc-0003");
  });

  it("never picks an ineligible drive, however much space it has", () => {
    const huge = candidate({ fsUuid: "ffff-9999", freeBytes: 99_000 * GIB, encryption: "none" });
    expect(pickRecordingsDrive([huge, A])?.fsUuid).toBe("aaaa-0001");
    const os = candidate({ fsUuid: "eeee-5555", freeBytes: 99_000 * GIB, isSystemDisk: true });
    expect(pickRecordingsDrive([os, A])?.fsUuid).toBe("aaaa-0001");
    const unprepared = candidate({ fsUuid: "eeee-6666", freeBytes: 99_000 * GIB, preparation: "needs_preparing" });
    expect(pickRecordingsDrive([unprepared, A])?.fsUuid).toBe("aaaa-0001");
  });

  it("the answer does not depend on the order the bridge listed the drives in", () => {
    const all = [A, B, C, D];
    const rotations = all.map((_, i) => [...all.slice(i), ...all.slice(0, i)]);
    for (const r of [...rotations, [...all].reverse()]) {
      expect(pickRecordingsDrive(r)?.fsUuid).toBe("cccc-0003");
    }
  });

  it("does not mutate the list it is given", () => {
    const list = Object.freeze([A, B]);
    expect(() => pickRecordingsDrive(list)).not.toThrow();
  });
});

describe("normalizeBridgeDrive", () => {
  /** What device-bridge.py `drives_snapshot()` emits today, plus WARP-3513's two fields. */
  const SNAKE = {
    device: "/dev/mapper/droplet-bay-1111aaaa",
    parent_disk: "sdb",
    mount: "/mnt/droplet/Bay-1111aaaa",
    label: "Bay",
    uuid: "1111-aaaa",
    size_bytes: 1000 * GIB,
    used_bytes: 100 * GIB,
    free_bytes: 900 * GIB,
    mounted: true,
    fs: "ext4",
    bus: "sata",
    readonly: false,
    smart: "PASSED",
    temp_c: 31,
    removable: false,
    source: "fstab",
    encryption: "luks2",
    preparation: "prepared",
    md: null,
  };
  const CTX = { osDisk: "nvme0n1", disksByName: new Map([["sdb", { model: "Acme SSD" }]]) };

  it("maps the bridge's snake_case drive to a candidate", () => {
    expect(normalizeBridgeDrive(SNAKE, CTX)).toEqual(candidate());
  });

  it("the camelCase / contract spelling normalises to exactly the same candidate", () => {
    const camel = {
      fsUuid: "1111-aaaa",
      label: "Bay",
      sizeBytes: 1000 * GIB,
      usedBytes: 100 * GIB,
      freeBytes: 900 * GIB,
      mountPath: "/mnt/droplet/Bay-1111aaaa",
      mounted: true,
      readOnly: false,
      fsType: "ext4",
      smart: "PASSED",
      parentDisk: "sdb",
      encryption: "luks2",
      preparation: "prepared",
      isSystemDisk: false,
    };
    expect(normalizeBridgeDrive(camel, CTX)).toEqual(normalizeBridgeDrive(SNAKE, CTX));
  });

  it("accepts the other spellings WARP-3513 may use (is_system_disk, read_only)", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, readonly: undefined, read_only: true, is_system_disk: true }, CTX);
    expect(d?.readOnly).toBe(true);
    expect(d?.isSystemDisk).toBe(true);
  });

  it("a drive is the system disk when it says so, OR when its parent disk is the OS disk", () => {
    expect(normalizeBridgeDrive({ ...SNAKE, isSystemDisk: true }, CTX)?.isSystemDisk).toBe(true);
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: "nvme0n1" }, CTX)?.isSystemDisk).toBe(true);
    expect(normalizeBridgeDrive(SNAKE, CTX)?.isSystemDisk).toBe(false);
    // …and a flag explicitly saying false does not override a parent-disk match.
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: "nvme0n1", isSystemDisk: false }, CTX)?.isSystemDisk).toBe(true);
  });

  it("the OS-disk drive is then rejected by the eligibility rule", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, parent_disk: "nvme0n1" }, CTX);
    expect(d && ineligibleReasons(d)).toEqual(["system_disk"]);
  });

  it("an unknown OS disk (empty string or no context) matches nothing — the bridge's own filter stays the first layer", () => {
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: "" }, { osDisk: "" })?.isSystemDisk).toBe(false);
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: "nvme0n1" })?.isSystemDisk).toBe(false);
  });

  it("the model comes from the physical-disk inventory; it is '' when the disk is not listed", () => {
    expect(normalizeBridgeDrive(SNAKE, CTX)?.model).toBe("Acme SSD");
    expect(normalizeBridgeDrive(SNAKE, { osDisk: "nvme0n1", disksByName: new Map() })?.model).toBe("");
    expect(normalizeBridgeDrive(SNAKE)?.model).toBe("");
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: undefined }, CTX)?.model).toBe("");
    expect(normalizeBridgeDrive({ ...SNAKE, parent_disk: undefined }, CTX)?.parentDisk).toBeNull();
  });

  it("the SMART verdict is normalised to PASSED / FAILED / null", () => {
    expect(normalizeBridgeDrive({ ...SNAKE, smart: "FAILED" })?.smart).toBe("FAILED");
    expect(normalizeBridgeDrive({ ...SNAKE, smart: " passed " })?.smart).toBe("PASSED");
    expect(normalizeBridgeDrive({ ...SNAKE, smart: "WARNING" })?.smart).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, smart: null })?.smart).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, smart: 1 })?.smart).toBeNull();
  });

  it("an empty filesystem type means 'not reported' (null), not a mismatch", () => {
    expect(normalizeBridgeDrive({ ...SNAKE, fs: "" })?.fsType).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, fs: undefined })?.fsType).toBeNull();
  });

  it("anything missing or unrecognised is 'unknown' / the conservative default — never a guess", () => {
    const d = normalizeBridgeDrive({ uuid: "1111-aaaa" });
    expect(d).toEqual({
      fsUuid: "1111-aaaa",
      label: "",
      model: "",
      sizeBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      mountPath: "",
      mounted: false,
      readOnly: true,
      fsType: null,
      encryption: "unknown",
      preparation: "unknown",
      isSystemDisk: false,
      smart: null,
      parentDisk: null,
    });
    expect(d && ineligibleReasons(d)).toEqual(
      expect.arrayContaining(["not_mounted", "read_only", "not_encrypted", "not_prepared", "too_small"]),
    );
  });

  it("unrecognised encryption / preparation values are 'unknown', not passed through", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, encryption: "aes-xts", preparation: "ready" });
    expect(d?.encryption).toBe("unknown");
    expect(d?.preparation).toBe("unknown");
    expect(normalizeBridgeDrive({ ...SNAKE, encryption: "none", preparation: "needs_preparing" })).toMatchObject({
      encryption: "none",
      preparation: "needs_preparing",
    });
  });

  it("the enum match is exact: a differently-cased 'LUKS2' is NOT accepted as encryption", () => {
    // Exact-match is the safe direction for a gate — only the contract's own
    // spelling counts as a positive claim.
    expect(normalizeBridgeDrive({ ...SNAKE, encryption: "LUKS2" })?.encryption).toBe("unknown");
    expect(normalizeBridgeDrive({ ...SNAKE, preparation: "Prepared" })?.preparation).toBe("unknown");
  });

  it("a drive reported WITHOUT a `preparation` field stays 'unknown' and ineligible, even when `encryption` is luks2", () => {
    // The raw bridge snapshot WARP-3513 emits carries `encryption`; if `preparation`
    // is not on the same object the rule is "the drive must SAY prepared" — we do
    // not derive it. This test pins that on purpose: changing it is a conscious
    // decision about a safety gate, not a side effect.
    const d = normalizeBridgeDrive({ ...SNAKE, preparation: undefined }, CTX);
    expect(d?.encryption).toBe("luks2");
    expect(d?.preparation).toBe("unknown");
    expect(d && ineligibleReasons(d)).toEqual(["not_prepared"]);
  });

  it("the pre-WARP-3513 bridge (no encryption, no preparation at all) yields ineligible drives", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, encryption: undefined, preparation: undefined }, CTX);
    expect(d?.encryption).toBe("unknown");
    expect(d?.preparation).toBe("unknown");
    expect(d && isEligibleRecordingsDrive(d)).toBe(false);
  });

  it("a drive the bridge reports without a uuid cannot be targeted: null", () => {
    expect(normalizeBridgeDrive({ ...SNAKE, uuid: "" })).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, uuid: "   " })).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, uuid: undefined })).toBeNull();
    expect(normalizeBridgeDrive({ ...SNAKE, uuid: 42 })).toBeNull();
  });

  it("junk input is null, never a throw", () => {
    for (const junk of [null, undefined, "drive", 42, true, [], [SNAKE], () => 1]) {
      expect(normalizeBridgeDrive(junk)).toBeNull();
    }
    expect(normalizeBridgeDrive({})).toBeNull();
  });

  it("non-numeric or negative sizes are 0 (which fails the free-space floor), never NaN", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, size_bytes: "huge", used_bytes: -1, free_bytes: Number.NaN });
    expect(d).toMatchObject({ sizeBytes: 0, usedBytes: 0, freeBytes: 0 });
  });

  it("copes with a hostile label: it is carried as text, never interpreted", () => {
    const d = normalizeBridgeDrive({ ...SNAKE, label: "<img src=x onerror=alert(1)>" });
    expect(d?.label).toBe("<img src=x onerror=alert(1)>");
  });
});
