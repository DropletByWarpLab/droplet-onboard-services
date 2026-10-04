/**
 * WARP-3514 / ADR-070 — facts → status, warnings and the `GET /api/storage/recordings`
 * body. Pure: one `RecordingsFacts` in, one answer out, so the API, the hourly
 * health check and the allocator all agree on what "active" or "missing" means.
 *
 * The precedence rules are the product behaviour (live truth beats a stale DB
 * status; a MISSING row whose drive is back is recovering, not missing; an
 * unreachable bridge is never read as "all clear"), so each rule has its own
 * test AND each precedence boundary is pinned.
 */
import { describe, expect, it } from "vitest";
import type {
  AllocationRecord,
  NvrHostStatus,
  NvrMigrationStatus,
  RecordingsDriveCandidate,
  RecordingsFacts,
  RecordingsFrigateFacts,
  RecordingsSizing,
  RecordingsWarningCode,
} from "./recordings.types.js";
import {
  RECORDINGS_WARNING_MESSAGES,
  buildRecordingsOverview,
  deriveRecordingsStatus,
  deriveRecordingsWarnings,
} from "./recordings-overview.js";
import { GIB, MIB } from "./recordings-sizing.js";

const g = (gib: number): number => gib * GIB;
const FS = "1111-aaaa";

function allocation(over: Partial<AllocationRecord> = {}): AllocationRecord {
  return {
    id: "alloc-1",
    fsUuid: FS,
    mode: "AUTO_RESERVED",
    reservedBytes: g(200),
    status: "ACTIVE",
    migrationFailures: 0,
    lastFailureAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    ...over,
  };
}

function drive(over: Partial<RecordingsDriveCandidate> = {}): RecordingsDriveCandidate {
  return {
    fsUuid: FS,
    label: "Bay",
    model: "Acme SSD",
    sizeBytes: g(1000),
    usedBytes: g(100),
    freeBytes: g(900),
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

/** Frigate records onto the bay drive's `nvr/` slice — the healthy end state. */
function bayHost(over: Partial<NvrHostStatus> = {}): NvrHostStatus {
  return {
    source: "/mnt/droplet/Bay-1111aaaa/nvr",
    kind: "path",
    fsUuid: FS,
    mountPath: "/mnt/droplet/Bay-1111aaaa",
    physicalDisk: "sdb",
    backingDevices: ["sdb", "droplet-bay-1111aaaa"],
    isSystemDisk: false,
    encrypted: true,
    mounted: true,
    rw: true,
    projectId: 4096,
    limitBytes: g(200),
    usedBytes: g(50),
    fsSizeBytes: g(1000),
    fsFreeBytes: g(900),
    ...over,
  };
}

/** Frigate records onto the named docker volume on the OS disk — the state this feature ends. */
function volumeHost(over: Partial<NvrHostStatus> = {}): NvrHostStatus {
  return {
    source: "nvrdata",
    kind: "volume",
    fsUuid: null,
    mountPath: null,
    physicalDisk: "nvme0n1",
    backingDevices: ["nvme0n1", "nvme0n1p2"],
    isSystemDisk: true,
    encrypted: false,
    mounted: true,
    rw: true,
    projectId: null,
    limitBytes: null,
    usedBytes: null,
    fsSizeBytes: g(1800),
    fsFreeBytes: g(900),
    ...over,
  };
}

function migration(over: Partial<NvrMigrationStatus> = {}): NvrMigrationStatus {
  return {
    state: "idle",
    job: null,
    phase: null,
    progressPct: 0,
    bytesCopied: 0,
    bytesTotal: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    errorCode: null,
    oldSource: null,
    ...over,
  };
}

function frigate(over: Partial<RecordingsFrigateFacts> = {}): RecordingsFrigateFacts {
  return {
    volume: { path: "/media/frigate/recordings", totalBytes: g(200), usedBytes: g(50), freeBytes: g(150), usedPercent: 25 },
    cameras: [
      { camera: "front_door", usedBytes: g(30), bytesPerHour: 500 * MIB },
      { camera: "garage", usedBytes: g(20), bytesPerHour: 250 * MIB },
    ],
    totalBytesPerHour: 750 * MIB,
    recordingsOnBootDisk: false,
    ...over,
  };
}

/** Worked by hand: 500 / 250 MiB/h × 24 × 7 × 1.25 × 1.02 × MIB (see recordings-sizing.test.ts). */
const SIZING: RecordingsSizing = {
  retentionDays: 7,
  cameras: [
    { name: "front_door", mbPerHour: 500, needBytes: 112_302_489_600, basis: "history" },
    { name: "garage", mbPerHour: 250, needBytes: 56_151_244_800, basis: "history" },
    { name: "patio", mbPerHour: null, needBytes: 0, basis: "none" },
  ],
  sumBytes: 168_453_734_400,
  needTotalBytes: 168_453_734_400,
};

/** A healthy, ACTIVE box: slice on the bay drive, 25 % full, need comfortably inside the reservation. */
function facts(over: Partial<RecordingsFacts> = {}): RecordingsFacts {
  const subject = "allocation" in over ? (over.allocation ?? null) : allocation();
  return {
    at: new Date("2026-10-03T12:00:00.000Z"),
    allocation: subject,
    allocations: subject ? [subject] : [],
    host: bayHost(),
    hostError: null,
    migration: migration(),
    drives: [drive()],
    drivesError: null,
    frigate: frigate(),
    sizing: SIZING,
    cameraNames: { front_door: "Front Door", garage: "Garage" },
    ...over,
  };
}

const status = (over: Partial<RecordingsFacts> = {}) => deriveRecordingsStatus(facts(over));
const codes = (over: Partial<RecordingsFacts> = {}): RecordingsWarningCode[] =>
  deriveRecordingsWarnings(facts(over)).map((w) => w.code);

/**
 * A need that cannot fit: reserved 200 GiB, measured need 300 GiB, but the slice holds
 * only 100 GiB and the filesystem has just 50 GiB free (other data fills the rest) —
 * the most it could ever hold is 150 GiB, below the reservation. Not near full (50 %).
 */
const NO_ROOM: Partial<RecordingsFacts> = {
  host: bayHost({ usedBytes: g(100), fsFreeBytes: g(50) }),
  sizing: { ...SIZING, needTotalBytes: g(300) },
};

describe("deriveRecordingsStatus — first match wins", () => {
  describe("1. no allocation row", () => {
    it("an eligible drive exists and the host answer is unknown → pending (the allocator creates the row on its next tick)", () => {
      expect(status({ allocation: null, host: null, migration: null })).toBe("pending");
    });

    it("recordings on the OS disk with somewhere to move them → on_system_disk (it outranks pending)", () => {
      expect(status({ allocation: null, host: volumeHost(), migration: null })).toBe("on_system_disk");
    });

    it("recordings on the OS disk but nothing eligible → no_eligible_drive (nothing to move them to)", () => {
      expect(status({ allocation: null, host: volumeHost(), drives: [] })).toBe("no_eligible_drive");
    });

    it("no eligible drive → no_eligible_drive", () => {
      expect(status({ allocation: null, drives: [drive({ encryption: "none", preparation: "needs_preparing" })] })).toBe(
        "no_eligible_drive",
      );
      expect(status({ allocation: null, drives: [] })).toBe("no_eligible_drive");
    });

    it("a box where WARP-3513's fields are not reported yet (everything 'unknown') is no_eligible_drive — correct, not a bug", () => {
      expect(
        status({ allocation: null, drives: [drive({ encryption: "unknown", preparation: "unknown" })] }),
      ).toBe("no_eligible_drive");
    });

    it("the host and a stale migration record do not matter without a row", () => {
      expect(
        status({ allocation: null, drives: [], host: volumeHost(), migration: migration({ state: "failed", job: "migrate" }) }),
      ).toBe("no_eligible_drive");
    });
  });

  describe("2. MIGRATING", () => {
    const migrating = { allocation: allocation({ status: "MIGRATING" }), host: volumeHost() };

    it("a running move is migrating", () => {
      expect(status({ ...migrating, migration: migration({ state: "running", job: "migrate" }) })).toBe("migrating");
    });

    it("no job record, or no migration facts at all, is still migrating (the allocator restarts it)", () => {
      expect(status({ ...migrating, migration: migration() })).toBe("migrating");
      expect(status({ ...migrating, migration: null })).toBe("migrating");
    });

    it("a FAILED move is degraded", () => {
      expect(
        status({ ...migrating, migration: migration({ state: "failed", job: "migrate", errorCode: "copy_failed" }) }),
      ).toBe("degraded");
    });

    it("a finished-but-not-yet-recorded move is migrating (the allocator flips the row on its next poll)", () => {
      expect(status({ ...migrating, migration: migration({ state: "done", job: "migrate" }) })).toBe("migrating");
    });

    it("a failed DELETE-OLD job does not degrade a migrating row — only a failed migrate does", () => {
      expect(status({ ...migrating, migration: migration({ state: "failed", job: "delete_old" }) })).toBe("migrating");
    });

    it("missing outranks migrating: a vanished drive mid-move is reported missing", () => {
      expect(status({ ...migrating, drives: [], migration: migration({ state: "running", job: "migrate" }) })).toBe(
        "missing",
      );
    });
  });

  describe("3. PENDING", () => {
    it("a PENDING row whose drive is absent is missing", () => {
      expect(status({ allocation: allocation({ status: "PENDING" }), drives: [], host: volumeHost() })).toBe("missing");
    });

    it("on_system_disk outranks pending: a PENDING row while recordings are still on the OS disk (retries exhausted)", () => {
      expect(status({ allocation: allocation({ status: "PENDING" }), host: volumeHost() })).toBe("on_system_disk");
    });

    it("a PENDING row while recordings are safely on a bay drive is pending", () => {
      expect(status({ allocation: allocation({ status: "PENDING" }), host: bayHost() })).toBe("pending");
    });
  });

  describe("4. the drive is gone — live truth beats a stale row", () => {
    it.each(["ACTIVE", "DEGRADED", "MISSING"] as const)("a %s row whose drive is not in the bridge's list is missing", (s) => {
      expect(status({ allocation: allocation({ status: s }), drives: [] })).toBe("missing");
    });

    it("an unmounted drive entry counts as absent", () => {
      expect(status({ drives: [drive({ mounted: false })] })).toBe("missing");
    });

    it("a drive listed under a DIFFERENT filesystem uuid does not count", () => {
      expect(status({ drives: [drive({ fsUuid: "9999-zzzz" })] })).toBe("missing");
    });

    it("the host says the bay path is not mounted → missing, even though the drive list still shows the drive", () => {
      expect(
        status({ host: bayHost({ mounted: false, rw: false, isSystemDisk: true, fsUuid: null, encrypted: false }) }),
      ).toBe("missing");
    });

    it("a MISSING row whose drive is BACK is recovering, not missing: it falls through to the live checks", () => {
      expect(status({ allocation: allocation({ status: "MISSING" }) })).toBe("active");
      expect(status({ allocation: allocation({ status: "MISSING" }), host: null, hostError: "bridge down" })).toBe("active");
    });

    it("a MISSING row whose drive is back but read-only is degraded, not missing", () => {
      expect(status({ allocation: allocation({ status: "MISSING" }), drives: [drive({ readOnly: true })] })).toBe("degraded");
    });

    it("beats on_system_disk: an unmounted bay resolves onto the OS disk host-side, but the truth is 'missing'", () => {
      expect(status({ drives: [], host: volumeHost() })).toBe("missing");
    });
  });

  describe("5. on the system disk", () => {
    it("the host source is the docker volume → on_system_disk (the allocator re-applies the target)", () => {
      expect(status({ host: volumeHost() })).toBe("on_system_disk");
    });

    it("the host source is a mounted path that sits on the OS disk → on_system_disk", () => {
      expect(status({ host: bayHost({ isSystemDisk: true }) })).toBe("on_system_disk");
    });

    it("degraded outranks on_system_disk: a degraded row recording to the OS disk is degraded (a failing drive is never auto-moved)", () => {
      expect(status({ allocation: allocation({ status: "DEGRADED" }), host: volumeHost() })).toBe("degraded");
    });
  });

  describe("6. degraded", () => {
    it("a DEGRADED row on a healthy path stays degraded", () => {
      expect(status({ allocation: allocation({ status: "DEGRADED" }) })).toBe("degraded");
    });

    it("a read-only drive degrades an ACTIVE row", () => {
      expect(status({ drives: [drive({ readOnly: true })] })).toBe("degraded");
    });

    it("a read-only mount (host side) degrades an ACTIVE row", () => {
      expect(status({ host: bayHost({ rw: false }) })).toBe("degraded");
    });

    it("a failing SMART verdict degrades an ACTIVE row", () => {
      expect(status({ drives: [drive({ smart: "FAILED" })] })).toBe("degraded");
    });

    it("a slice that cannot grow to the measured need degrades an ACTIVE row", () => {
      expect(status(NO_ROOM)).toBe("degraded");
    });

    it("near-full and not-encrypted are warnings but do NOT change the status", () => {
      expect(status({ host: bayHost({ usedBytes: g(190) }), frigate: null })).toBe("active");
      expect(status({ drives: [drive({ encryption: "none" })], host: bayHost({ encrypted: true }) })).toBe("active");
    });
  });

  describe("7. active", () => {
    it("a healthy ACTIVE row on the bay path", () => {
      expect(status()).toBe("active");
    });
  });

  describe("bridge unreachable (host === null): live checks that need the host are skipped, never guessed", () => {
    it("an ACTIVE row with its drive present stays active — not 'on the system disk', not 'missing'", () => {
      expect(status({ host: null, hostError: "bridge down" })).toBe("active");
    });

    it("the drive list still proves a missing drive without the host", () => {
      expect(status({ host: null, hostError: "bridge down", drives: [] })).toBe("missing");
    });

    it("the drive list still proves a read-only drive without the host", () => {
      expect(status({ host: null, hostError: "bridge down", drives: [drive({ readOnly: true })] })).toBe("degraded");
    });
  });
});

describe("deriveRecordingsWarnings", () => {
  it("a healthy box has none", () => {
    expect(deriveRecordingsWarnings(facts())).toEqual([]);
  });

  describe("drive_missing", () => {
    it("the row's drive is not in the list", () => {
      expect(codes({ drives: [] })).toEqual(["drive_missing"]);
    });

    it("the host says the bay path is unmounted (and that is NOT also 'on the system disk')", () => {
      const host = bayHost({ mounted: false, rw: false, isSystemDisk: true, fsUuid: null, encrypted: false });
      expect(codes({ host })).toEqual(["drive_missing"]);
    });

    it("needs a row: with no allocation an unmounted bay path warns about nothing", () => {
      const host = bayHost({ mounted: false, rw: false, isSystemDisk: true, fsUuid: null, encrypted: false });
      expect(codes({ allocation: null, drives: [], host })).toEqual([]);
    });
  });

  describe("read_only", () => {
    it("the drive is mounted read-only", () => {
      expect(codes({ drives: [drive({ readOnly: true })] })).toEqual(["read_only"]);
    });

    it("the host mount is read-only", () => {
      expect(codes({ host: bayHost({ rw: false }) })).toEqual(["read_only"]);
    });

    it("an unmounted host path is 'missing', not 'read-only'", () => {
      const host = bayHost({ mounted: false, rw: false, isSystemDisk: true, fsUuid: null, encrypted: false });
      expect(codes({ host })).not.toContain("read_only");
    });
  });

  describe("smart_failed", () => {
    it("fires on a FAILED verdict only", () => {
      expect(codes({ drives: [drive({ smart: "FAILED" })] })).toEqual(["smart_failed"]);
      expect(codes({ drives: [drive({ smart: "PASSED" })] })).toEqual([]);
      expect(codes({ drives: [drive({ smart: null })] })).toEqual([]);
    });
  });

  describe("not_encrypted", () => {
    it("the allocated drive is not LUKS2 (none or unknown)", () => {
      expect(codes({ drives: [drive({ encryption: "none" })] })).toEqual(["not_encrypted"]);
      expect(codes({ drives: [drive({ encryption: "unknown" })] })).toEqual(["not_encrypted"]);
    });

    it("the host reports the mounted slice as not encrypted", () => {
      expect(codes({ host: bayHost({ encrypted: false }) })).toEqual(["not_encrypted"]);
    });

    it("needs a row: an unencrypted drive with no allocation is simply not eligible, not a warning", () => {
      expect(codes({ allocation: null, drives: [drive({ encryption: "none" })], host: bayHost({ encrypted: false }) })).toEqual(
        [],
      );
    });
  });

  describe("on_system_disk", () => {
    it("the host source is the docker volume", () => {
      expect(codes({ host: volumeHost() })).toContain("on_system_disk");
    });

    it("the host source is a mounted path on the OS disk", () => {
      expect(codes({ host: bayHost({ isSystemDisk: true }) })).toContain("on_system_disk");
    });

    it("fires EVEN WITH ZERO CAMERAS and no allocation: the recordings target is the OS disk", () => {
      const out = deriveRecordingsWarnings(
        facts({
          allocation: null,
          drives: [],
          host: volumeHost(),
          migration: null,
          frigate: frigate({ cameras: [], totalBytesPerHour: null, volume: null }),
          sizing: { retentionDays: 7, cameras: [], sumBytes: 0, needTotalBytes: g(20) },
          cameraNames: {},
        }),
      );
      expect(out.map((w) => w.code)).toEqual(["on_system_disk"]);
    });

    it("does not fire when the bridge could not be asked (host null is not 'on the OS disk')", () => {
      expect(codes({ host: null, hostError: "bridge down" })).toEqual([]);
    });

    it("an unmounted bay path is drive_missing, never on_system_disk", () => {
      const host = bayHost({ mounted: false, rw: false, isSystemDisk: true, fsUuid: null, encrypted: false });
      expect(codes({ host })).not.toContain("on_system_disk");
      expect(codes({ allocation: null, drives: [], host })).not.toContain("on_system_disk");
    });
  });

  describe("cannot_grow", () => {
    it("AUTO_RESERVED with no room to grow to the measured need", () => {
      expect(codes(NO_ROOM)).toEqual(["cannot_grow"]);
    });

    it("AUTO_RESERVED that can only PARTLY grow (the ceiling is above the reservation but below the need)", () => {
      // need 400, reserved 200: ceiling = used 150 + free 100 = 250 → grows to 250 < 400.
      expect(
        codes({
          host: bayHost({ usedBytes: g(150), fsFreeBytes: g(100) }),
          sizing: { ...SIZING, needTotalBytes: g(400) },
        }),
      ).toEqual(["cannot_grow"]);
    });

    it("a need that CAN be met by growing is not a warning (the allocator simply grows)", () => {
      expect(codes({ sizing: { ...SIZING, needTotalBytes: g(300) } })).toEqual([]);
    });

    it("whole-drive (FULL) mode has nothing to grow", () => {
      expect(codes({ ...NO_ROOM, allocation: allocation({ mode: "FULL", reservedBytes: g(1000) }) })).toEqual([]);
    });

    it("a failed migration with insufficient_space is a cannot_grow too", () => {
      expect(
        codes({
          allocation: allocation({ status: "DEGRADED" }),
          migration: migration({ state: "failed", job: "migrate", errorCode: "insufficient_space" }),
        }),
      ).toEqual(["cannot_grow"]);
    });

    it("a migration that failed for another reason is not", () => {
      expect(
        codes({ migration: migration({ state: "failed", job: "migrate", errorCode: "copy_failed" }) }),
      ).toEqual([]);
    });

    it("is not guessed when the figures are not known (no host, no Frigate volume)", () => {
      expect(codes({ ...NO_ROOM, host: null, hostError: "bridge down", frigate: null })).toEqual([]);
    });

    it("falls back to the drive's own free space when the bridge cannot be asked", () => {
      // used from Frigate (190 GiB), free from the drive entry (5 GiB) → no room.
      expect(
        codes({
          host: null,
          hostError: "bridge down",
          drives: [drive({ freeBytes: g(5) })],
          frigate: frigate({ volume: { path: "/r", totalBytes: g(200), usedBytes: g(190), freeBytes: g(10), usedPercent: 95 } }),
          sizing: { ...SIZING, needTotalBytes: g(300) },
        }),
      ).toContain("cannot_grow");
    });
  });

  describe("near_full", () => {
    it("AUTO_RESERVED: used / reserved ≥ 85 %, the boundary inclusive", () => {
      expect(codes({ allocation: allocation({ reservedBytes: g(100) }), host: bayHost({ usedBytes: g(85) }), sizing: { ...SIZING, needTotalBytes: g(20) } })).toEqual(["near_full"]);
      expect(codes({ allocation: allocation({ reservedBytes: g(100) }), host: bayHost({ usedBytes: g(84) }), sizing: { ...SIZING, needTotalBytes: g(20) } })).toEqual([]);
    });

    it("FULL: measured against the filesystem size, not the reservation", () => {
      const full = allocation({ mode: "FULL", reservedBytes: g(1000) });
      expect(codes({ allocation: full, host: bayHost({ usedBytes: g(850) }) })).toEqual(["near_full"]);
      expect(codes({ allocation: full, host: bayHost({ usedBytes: g(849) }) })).toEqual([]);
    });

    it("uses Frigate's own volume figure when the host did not report usage", () => {
      const f = frigate({ volume: { path: "/r", totalBytes: g(200), usedBytes: g(190), freeBytes: g(10), usedPercent: 95 } });
      expect(codes({ host: bayHost({ usedBytes: null }), frigate: f, sizing: { ...SIZING, needTotalBytes: g(20) } })).toEqual(["near_full"]);
    });

    it("is not guessed when usage is unknown everywhere", () => {
      expect(codes({ host: null, hostError: "down", frigate: null })).toEqual([]);
    });

    it("needs a row", () => {
      expect(codes({ allocation: null, drives: [], host: bayHost({ usedBytes: g(999) }) })).not.toContain("near_full");
    });
  });

  it("returns warnings in the stable order: drive_missing, read_only, smart_failed, not_encrypted, on_system_disk, cannot_grow, near_full", () => {
    // Everything that can co-occur with a PRESENT drive on the OS disk.
    const present = deriveRecordingsWarnings(
      facts({
        allocation: allocation({ reservedBytes: g(100) }),
        drives: [drive({ readOnly: true, smart: "FAILED", encryption: "none", freeBytes: g(5) })],
        host: volumeHost(),
        frigate: frigate({ volume: { path: "/r", totalBytes: g(1800), usedBytes: g(95), freeBytes: g(900), usedPercent: 5.3 } }),
        sizing: { ...SIZING, needTotalBytes: g(300) },
      }),
    );
    expect(present.map((w) => w.code)).toEqual([
      "read_only",
      "smart_failed",
      "not_encrypted",
      "on_system_disk",
      "cannot_grow",
      "near_full",
    ]);

    // …and the one that needs the drive to be absent.
    const absent = deriveRecordingsWarnings(
      facts({ drives: [], host: bayHost({ rw: false, encrypted: false }) }),
    );
    expect(absent.map((w) => w.code)).toEqual(["drive_missing", "read_only", "not_encrypted"]);
  });

  it("each warning carries its fixed owner-facing message", () => {
    const out = deriveRecordingsWarnings(facts({ drives: [drive({ smart: "FAILED" })] }));
    expect(out).toEqual([{ code: "smart_failed", message: RECORDINGS_WARNING_MESSAGES.smart_failed }]);
  });

  it("WARP-3466: no drive label, mount path or device path ever appears in a warning", () => {
    const secretLabel = "SECRET-LABEL-do-not-leak";
    const out = deriveRecordingsWarnings(
      facts({
        drives: [
          drive({
            label: secretLabel,
            mountPath: `/mnt/droplet/${secretLabel}-1111aaaa`,
            readOnly: true,
            smart: "FAILED",
            encryption: "none",
            freeBytes: g(5),
          }),
        ],
        host: volumeHost({ source: `/mnt/droplet/${secretLabel}-1111aaaa/nvr`, mountPath: `/mnt/droplet/${secretLabel}-1111aaaa` }),
        sizing: { ...SIZING, needTotalBytes: g(300) },
      }),
    );
    expect(out.length).toBeGreaterThan(3);
    const text = JSON.stringify(out);
    expect(text).not.toContain(secretLabel);
    expect(text).not.toMatch(/\/mnt|\/dev|\/media|\/var|sdb|nvme/);
  });
});

describe("RECORDINGS_WARNING_MESSAGES", () => {
  const ALL: RecordingsWarningCode[] = [
    "drive_missing",
    "read_only",
    "near_full",
    "cannot_grow",
    "on_system_disk",
    "smart_failed",
    "not_encrypted",
  ];

  it("has exactly one message per warning code", () => {
    expect(Object.keys(RECORDINGS_WARNING_MESSAGES).sort()).toEqual([...ALL].sort());
  });

  it("every message is a complete owner-facing sentence with no path, device or label in it", () => {
    for (const code of ALL) {
      const m = RECORDINGS_WARNING_MESSAGES[code];
      expect(m.length).toBeGreaterThan(30);
      expect(m).toMatch(/[.!]$/);
      expect(m).not.toMatch(/\/|\\|sd[a-z]|nvme|mnt|\{|\}/);
    }
  });

  it("never claims footage is written to the system disk unless that is the warning", () => {
    expect(RECORDINGS_WARNING_MESSAGES.drive_missing).toMatch(/system disk/i); // reassures: it is NOT being written there
    expect(RECORDINGS_WARNING_MESSAGES.drive_missing).toMatch(/never|not/i);
  });
});

describe("buildRecordingsOverview — the GET /api/storage/recordings body", () => {
  it("maps a healthy box to the WARP-3512 contract shape exactly", () => {
    // 50 GiB used at 750 MiB/h × 24 = 18 000 MiB/day → 51 200 / 18 000 = 2.84 days.
    expect(buildRecordingsOverview(facts())).toEqual({
      status: "active",
      mode: "auto_reserved",
      drive: {
        fsUuid: FS,
        label: "Bay",
        model: "Acme SSD",
        sizeBytes: g(1000),
        encrypted: true,
        mountPath: "/mnt/droplet/Bay-1111aaaa",
      },
      reservedBytes: g(200),
      usedBytes: g(50),
      freeBytes: g(150),
      needBytes: 168_453_734_400,
      retentionDays: 7,
      daysStored: 2.8,
      cameras: [
        { name: "front_door", displayName: "Front Door", mbPerHour: 500, gbPerDay: 11.72, needBytes: 112_302_489_600, usedBytes: g(30) },
        { name: "garage", displayName: "Garage", mbPerHour: 250, gbPerDay: 5.86, needBytes: 56_151_244_800, usedBytes: g(20) },
        { name: "patio", displayName: "patio", mbPerHour: 0, gbPerDay: 0, needBytes: 0, usedBytes: 0 },
      ],
      migration: { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null },
      oldFootage: { present: false, bytes: 0, location: "system_disk" },
      warnings: [],
      eligibleDrives: [{ fsUuid: FS, label: "Bay", sizeBytes: g(1000), freeBytes: g(900), encrypted: true }],
    });
  });

  it("is plain JSON: nothing undefined, nothing NaN, nothing that does not survive a round trip", () => {
    const o = buildRecordingsOverview(facts());
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
    const bare = buildRecordingsOverview(
      facts({ allocation: null, drives: [], host: null, hostError: "down", migration: null, frigate: null }),
    );
    expect(JSON.parse(JSON.stringify(bare))).toEqual(bare);
  });

  it("FULL mode: mode 'full', reserved = the filesystem, free = the host's filesystem free space", () => {
    const o = buildRecordingsOverview(
      facts({ allocation: allocation({ mode: "FULL", reservedBytes: g(1000) }), host: bayHost({ limitBytes: g(1000) }) }),
    );
    expect(o.mode).toBe("full");
    expect(o.reservedBytes).toBe(g(1000));
    expect(o.freeBytes).toBe(g(900)); // host.fsFreeBytes, not reserved − used (950)
  });

  it("FULL mode without a host figure falls back to reserved − used", () => {
    const o = buildRecordingsOverview(
      facts({ allocation: allocation({ mode: "FULL", reservedBytes: g(1000) }), host: bayHost({ fsFreeBytes: null }) }),
    );
    expect(o.freeBytes).toBe(g(950));
  });

  it("freeBytes is never negative (used past the reservation reports 0 free)", () => {
    const o = buildRecordingsOverview(facts({ allocation: allocation({ reservedBytes: g(40) }) }));
    expect(o.usedBytes).toBe(g(50));
    expect(o.freeBytes).toBe(0);
  });

  it("usage falls back to Frigate's volume figure when the host reports none, then to 0", () => {
    expect(buildRecordingsOverview(facts({ host: bayHost({ usedBytes: null }) })).usedBytes).toBe(g(50));
    const none = buildRecordingsOverview(facts({ host: null, hostError: "down", frigate: null }));
    expect(none.usedBytes).toBe(0);
    expect(none.freeBytes).toBe(g(200));
  });

  it("no allocation and no drive: status no_eligible_drive, a null mode and drive, zero reservation", () => {
    const o = buildRecordingsOverview(
      facts({
        allocation: null,
        drives: [],
        host: volumeHost(),
        migration: null,
        frigate: frigate({
          volume: { path: "/media/frigate/recordings", totalBytes: g(1800), usedBytes: g(300), freeBytes: g(900), usedPercent: 16.7 },
        }),
      }),
    );
    expect(o.status).toBe("no_eligible_drive");
    expect(o.mode).toBeNull();
    expect(o.drive).toBeNull();
    expect(o.reservedBytes).toBe(0);
    expect(o.usedBytes).toBe(g(300));
    expect(o.freeBytes).toBe(g(900)); // Frigate's volume free space when there is no slice
    expect(o.eligibleDrives).toEqual([]);
    expect(o.warnings.map((w) => w.code)).toEqual(["on_system_disk"]);
  });

  it("no allocation but an eligible drive: pending, and that drive is offered", () => {
    const o = buildRecordingsOverview(facts({ allocation: null, host: null }));
    expect(o.status).toBe("pending");
    expect(o.eligibleDrives).toEqual([{ fsUuid: FS, label: "Bay", sizeBytes: g(1000), freeBytes: g(900), encrypted: true }]);
  });

  it("eligibleDrives lists only eligible drives, in the bridge's order, always as encrypted", () => {
    const other = drive({ fsUuid: "2222-bbbb", label: "Spare", sizeBytes: g(500), freeBytes: g(400) });
    const o = buildRecordingsOverview(
      facts({
        drives: [drive({ fsUuid: "0000-zzzz", encryption: "none" }), other, drive()],
      }),
    );
    expect(o.eligibleDrives.map((d) => d.fsUuid)).toEqual(["2222-bbbb", FS]);
    expect(o.eligibleDrives.every((d) => d.encrypted === true)).toBe(true);
  });

  it("drive.encrypted is true only for LUKS2", () => {
    expect(buildRecordingsOverview(facts({ drives: [drive({ encryption: "none" })] })).drive?.encrypted).toBe(false);
    expect(buildRecordingsOverview(facts({ drives: [drive({ encryption: "unknown" })] })).drive?.encrypted).toBe(false);
  });

  it("drive: when the row's drive is gone, falls back to the candidate the host says it records onto", () => {
    const other = drive({ fsUuid: "2222-bbbb", label: "Elsewhere", mountPath: "/mnt/droplet/Elsewhere-2222bbbb" });
    const o = buildRecordingsOverview(facts({ drives: [other], host: bayHost({ fsUuid: "2222-bbbb" }) }));
    expect(o.drive).toMatchObject({ fsUuid: "2222-bbbb", label: "Elsewhere" });
  });

  it("drive: null when neither the row's drive nor the host's drive is known", () => {
    expect(buildRecordingsOverview(facts({ drives: [] })).drive).toBeNull();
  });

  describe("migration", () => {
    it("a running migrate job is reported verbatim", () => {
      const o = buildRecordingsOverview(
        facts({
          allocation: allocation({ status: "MIGRATING" }),
          host: volumeHost(),
          migration: migration({
            state: "running",
            job: "migrate",
            phase: "copy",
            progressPct: 42,
            bytesCopied: 420,
            bytesTotal: 1000,
            startedAt: "2026-10-03T11:00:00Z",
          }),
        }),
      );
      expect(o.status).toBe("migrating");
      expect(o.migration).toEqual({
        state: "running",
        progressPct: 42,
        bytesCopied: 420,
        bytesTotal: 1000,
        startedAt: "2026-10-03T11:00:00Z",
        error: null,
      });
    });

    it("a failed migrate job carries its error text", () => {
      const o = buildRecordingsOverview(
        facts({
          allocation: allocation({ status: "MIGRATING" }),
          host: volumeHost(),
          migration: migration({ state: "failed", job: "migrate", error: "not enough free space", errorCode: "insufficient_space" }),
        }),
      );
      expect(o.migration.state).toBe("failed");
      expect(o.migration.error).toBe("not enough free space");
    });

    it("a DELETE-OLD job is NOT a migration: it is reported as an idle, zeroed migration", () => {
      const o = buildRecordingsOverview(
        facts({
          migration: migration({
            state: "running",
            job: "delete_old",
            progressPct: 60,
            bytesCopied: 5,
            bytesTotal: 10,
            startedAt: "2026-10-03T11:00:00Z",
            oldSource: { kind: "volume", source: "nvrdata", bytes: g(120), deleted: false },
          }),
        }),
      );
      expect(o.migration).toEqual({ state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null });
      expect(o.oldFootage).toEqual({ present: true, bytes: g(120), location: "system_disk" });
    });

    it("unavailable migration facts read as an idle, zeroed migration", () => {
      expect(buildRecordingsOverview(facts({ migration: null })).migration).toEqual({
        state: "idle",
        progressPct: 0,
        bytesCopied: 0,
        bytesTotal: 0,
        startedAt: null,
        error: null,
      });
    });
  });

  describe("oldFootage", () => {
    const withOld = (oldSource: NvrMigrationStatus["oldSource"]) =>
      buildRecordingsOverview(facts({ migration: migration({ state: "done", job: "migrate", oldSource }) })).oldFootage;

    it("a kept docker volume is footage on the system disk", () => {
      expect(withOld({ kind: "volume", source: "nvrdata", bytes: g(300), deleted: false })).toEqual({
        present: true,
        bytes: g(300),
        location: "system_disk",
      });
    });

    it("a kept path source is footage on another drive", () => {
      expect(withOld({ kind: "path", source: "/mnt/droplet/Old-3333cccc/nvr", bytes: g(80), deleted: false })).toEqual({
        present: true,
        bytes: g(80),
        location: "other_drive",
      });
    });

    it("a deleted old source is no longer present", () => {
      expect(withOld({ kind: "volume", source: "nvrdata", bytes: g(300), deleted: true }).present).toBe(false);
    });

    it("no old source at all", () => {
      expect(withOld(null)).toEqual({ present: false, bytes: 0, location: "system_disk" });
    });
  });

  describe("cameras", () => {
    it("is the union of Frigate's cameras and the sizing's cameras, biggest user first, ties by name", () => {
      const o = buildRecordingsOverview(
        facts({
          frigate: frigate({
            cameras: [
              { camera: "b_cam", usedBytes: g(10), bytesPerHour: 100 * MIB },
              { camera: "a_cam", usedBytes: g(10), bytesPerHour: 100 * MIB },
              { camera: "z_big", usedBytes: g(99), bytesPerHour: 100 * MIB },
              { camera: "no_usage", usedBytes: null, bytesPerHour: null },
            ],
          }),
        }),
      );
      // z_big (99 GiB), a_cam / b_cam (10 GiB, tie → by name), then every camera with no usage, by name.
      expect(o.cameras.map((c) => c.name)).toEqual([
        "z_big",
        "a_cam",
        "b_cam",
        "front_door",
        "garage",
        "no_usage",
        "patio",
      ]);
    });

    it("the rate is Frigate's CURRENT rate when it has one, else the sizing's measured rate, else 0", () => {
      const o = buildRecordingsOverview(
        facts({
          frigate: frigate({
            cameras: [
              { camera: "front_door", usedBytes: g(30), bytesPerHour: 333.333 * MIB },
              { camera: "garage", usedBytes: g(20), bytesPerHour: null },
            ],
          }),
        }),
      );
      const by = Object.fromEntries(o.cameras.map((c) => [c.name, c]));
      expect(by.front_door.mbPerHour).toBe(333.33); // 2 dp
      expect(by.front_door.gbPerDay).toBe(7.81); // 333.333 × 24 / 1024 = 7.8125
      expect(by.garage.mbPerHour).toBe(250); // Frigate has no rate yet → the sizing's
      expect(by.patio.mbPerHour).toBe(0); // unknown everywhere → 0, never null/NaN
    });

    it("Frigate unreachable: cameras still come from the sizing, with zero usage", () => {
      const o = buildRecordingsOverview(facts({ frigate: null }));
      expect(o.cameras.map((c) => [c.name, c.usedBytes, c.mbPerHour])).toEqual([
        ["front_door", 0, 500],
        ["garage", 0, 250],
        ["patio", 0, 0],
      ]);
    });

    it("displayName is the customer-facing name, falling back to the camera name", () => {
      const o = buildRecordingsOverview(facts());
      expect(o.cameras.find((c) => c.name === "front_door")?.displayName).toBe("Front Door");
      expect(o.cameras.find((c) => c.name === "patio")?.displayName).toBe("patio");
    });

    it("a camera named like an Object.prototype member keeps its own name (no inherited lookup)", () => {
      const o = buildRecordingsOverview(
        facts({
          cameraNames: {},
          frigate: frigate({ cameras: [{ camera: "constructor", usedBytes: g(1), bytesPerHour: 10 * MIB }] }),
        }),
      );
      expect(o.cameras.find((c) => c.name === "constructor")?.displayName).toBe("constructor");
    });

    it("a Frigate camera the sizing does not know has need 0", () => {
      const o = buildRecordingsOverview(
        facts({ frigate: frigate({ cameras: [{ camera: "brand_new", usedBytes: g(1), bytesPerHour: 10 * MIB }] }) }),
      );
      expect(o.cameras.find((c) => c.name === "brand_new")?.needBytes).toBe(0);
    });
  });

  describe("daysStored", () => {
    it("is used ÷ (total rate × 24 h), to one decimal place", () => {
      expect(buildRecordingsOverview(facts()).daysStored).toBe(2.8);
    });

    it("is 0 when the rate is unknown or zero — never Infinity or NaN", () => {
      expect(buildRecordingsOverview(facts({ frigate: frigate({ totalBytesPerHour: null }) })).daysStored).toBe(0);
      expect(buildRecordingsOverview(facts({ frigate: frigate({ totalBytesPerHour: 0 }) })).daysStored).toBe(0);
      expect(buildRecordingsOverview(facts({ frigate: null })).daysStored).toBe(0);
    });
  });

  it("needBytes and retentionDays come straight from the sizing", () => {
    const o = buildRecordingsOverview(facts({ sizing: { ...SIZING, retentionDays: 14, needTotalBytes: g(77) } }));
    expect(o.needBytes).toBe(g(77));
    expect(o.retentionDays).toBe(14);
  });

  it("warnings and status in the body are the derived ones", () => {
    const f = facts({ drives: [drive({ smart: "FAILED" })] });
    const o = buildRecordingsOverview(f);
    expect(o.status).toBe(deriveRecordingsStatus(f));
    expect(o.status).toBe("degraded");
    expect(o.warnings).toEqual(deriveRecordingsWarnings(f));
  });

  it("does not mutate the facts it is given", () => {
    const f = facts();
    const before = JSON.stringify(f);
    buildRecordingsOverview(f);
    expect(JSON.stringify(f)).toBe(before);
  });
});
