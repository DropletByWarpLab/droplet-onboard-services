/**
 * WARP-3515 — the recording-storage contract, as the dashboard consumes it.
 *
 * `normalizeRecordingStorage` is the one place a wire payload becomes the typed
 * `RecordingStorage` the UI renders. The contract (WARP-3512) is shared by three
 * parallel backend branches that land separately, so the dashboard must survive
 * a payload that is partial, a field that is renamed-to-null, a status this
 * build has never heard of — and never crash on any of them.
 */
import { describe, it, expect } from "vitest";
import type { RecordingStorage } from "./types";
import {
  RECORDING_STORAGE_HREF,
  SETTINGS_STORAGE_HREF,
  cameraNeedShares,
  MIGRATION_RETRY_COPY,
  describeWarning,
  effectiveRecordingStatus,
  formatRate,
  friendlyRecordingStorageError,
  isWholeDriveBlockedByFiles,
  normalizeRecordingStorage,
  oldFootagePlace,
  recordingStatusView,
  recordingsDriveName,
} from "./recording-storage";

const GIB = 1024 ** 3;

/** The complete payload from the contract, with realistic numbers. */
function fullPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    mode: "auto_reserved",
    drive: {
      fsUuid: "fs-uuid-1",
      label: "Bay 2",
      model: "WD Red",
      sizeBytes: 4000 * GIB,
      encrypted: true,
      mountPath: "/mnt/droplet/bay2-1a2b3c4d",
    },
    reservedBytes: 120 * GIB,
    usedBytes: 40 * GIB,
    freeBytes: 80 * GIB,
    needBytes: 96 * GIB,
    retentionDays: 7,
    daysStored: 3.4,
    cameras: [
      {
        name: "front_door",
        displayName: "Front door",
        mbPerHour: 1500,
        gbPerDay: 36,
        needBytes: 63 * GIB,
        usedBytes: 20 * GIB,
      },
      {
        name: "garage",
        displayName: "Garage",
        mbPerHour: 700,
        gbPerDay: 16.8,
        needBytes: 33 * GIB,
        usedBytes: 20 * GIB,
      },
    ],
    migration: {
      state: "idle",
      progressPct: 0,
      bytesCopied: 0,
      bytesTotal: 0,
      startedAt: null,
      error: null,
    },
    oldFootage: { present: false, bytes: 0, location: "system_disk" },
    warnings: [],
    eligibleDrives: [
      {
        fsUuid: "fs-uuid-2",
        label: "Bay 3",
        sizeBytes: 2000 * GIB,
        freeBytes: 1900 * GIB,
        encrypted: true,
      },
    ],
    ...overrides,
  };
}

describe("normalizeRecordingStorage — the happy path", () => {
  it("passes a complete contract payload through unchanged", () => {
    const n = normalizeRecordingStorage(fullPayload());
    expect(n).not.toBeNull();
    expect(n!.status).toBe("active");
    expect(n!.mode).toBe("auto_reserved");
    expect(n!.drive).toEqual({
      fsUuid: "fs-uuid-1",
      label: "Bay 2",
      model: "WD Red",
      sizeBytes: 4000 * GIB,
      encrypted: true,
      mountPath: "/mnt/droplet/bay2-1a2b3c4d",
    });
    expect(n!.reservedBytes).toBe(120 * GIB);
    expect(n!.usedBytes).toBe(40 * GIB);
    expect(n!.freeBytes).toBe(80 * GIB);
    expect(n!.needBytes).toBe(96 * GIB);
    expect(n!.retentionDays).toBe(7);
    expect(n!.daysStored).toBe(3.4);
    expect(n!.cameras).toHaveLength(2);
    expect(n!.cameras[0]).toMatchObject({
      name: "front_door",
      displayName: "Front door",
      mbPerHour: 1500,
      gbPerDay: 36,
    });
    expect(n!.eligibleDrives).toEqual([
      {
        fsUuid: "fs-uuid-2",
        label: "Bay 3",
        sizeBytes: 2000 * GIB,
        freeBytes: 1900 * GIB,
        encrypted: true,
      },
    ]);
  });

  it.each([
    "active",
    "pending",
    "migrating",
    "degraded",
    "missing",
    "no_eligible_drive",
    "on_system_disk",
  ])("keeps the contract status %s", (status) => {
    expect(normalizeRecordingStorage(fullPayload({ status }))!.status).toBe(status);
  });

  it("keeps mode full", () => {
    expect(normalizeRecordingStorage(fullPayload({ mode: "full" }))!.mode).toBe("full");
  });

  it("preserves unknown retention and zeros estimates without changing recorded facts", () => {
    const n = normalizeRecordingStorage(fullPayload({
      retentionKnown: false,
      retentionDays: 7,
      needBytes: 96 * GIB,
      cameras: [
        { name: "front_door", displayName: "Front door", mbPerHour: 1500, gbPerDay: 36, needBytes: 75 * GIB, usedBytes: 20 * GIB },
      ],
    }))!;
    expect(n.retentionKnown).toBe(false);
    expect(n.retentionDays).toBe(0);
    expect(n.needBytes).toBe(0);
    expect(n.cameras[0]).toMatchObject({ needBytes: 0, usedBytes: 20 * GIB, gbPerDay: 36 });
    expect(n.usedBytes).toBe(40 * GIB);
    expect(n.reservedBytes).toBe(120 * GIB);
    expect(n.daysStored).toBe(3.4);
  });
});

describe("normalizeRecordingStorage — tolerance (never crash on a partial payload)", () => {
  it("returns null for something that is not an object", () => {
    expect(normalizeRecordingStorage(null)).toBeNull();
    expect(normalizeRecordingStorage(undefined)).toBeNull();
    expect(normalizeRecordingStorage("<html>")).toBeNull();
    expect(normalizeRecordingStorage(42)).toBeNull();
    expect(normalizeRecordingStorage([])).toBeNull();
  });

  it("turns an EMPTY object into a safe, renderable value", () => {
    const n = normalizeRecordingStorage({});
    expect(n).not.toBeNull();
    expect(n!.status).toBe("unknown");
    expect(n!.mode).toBeNull();
    expect(n!.drive).toBeNull();
    expect(n!.reservedBytes).toBe(0);
    expect(n!.usedBytes).toBe(0);
    expect(n!.freeBytes).toBe(0);
    expect(n!.needBytes).toBe(0);
    expect(n!.retentionDays).toBe(7);
    expect(n!.daysStored).toBe(0);
    expect(n!.cameras).toEqual([]);
    expect(n!.warnings).toEqual([]);
    expect(n!.eligibleDrives).toEqual([]);
    expect(n!.migration).toEqual({
      state: "idle",
      progressPct: 0,
      bytesCopied: 0,
      bytesTotal: 0,
      startedAt: null,
      error: null,
    });
    expect(n!.oldFootage).toEqual({ present: false, bytes: 0, location: "system_disk" });
  });

  it("maps a status it does not recognise to `unknown` instead of trusting it", () => {
    expect(normalizeRecordingStorage(fullPayload({ status: "rebalancing" }))!.status).toBe(
      "unknown",
    );
    expect(normalizeRecordingStorage(fullPayload({ status: 7 }))!.status).toBe("unknown");
  });

  it("drops a mode it does not recognise", () => {
    expect(normalizeRecordingStorage(fullPayload({ mode: "turbo" }))!.mode).toBeNull();
  });

  it("coerces non-finite / negative / string numbers to a safe value", () => {
    const n = normalizeRecordingStorage(
      fullPayload({
        reservedBytes: "lots",
        usedBytes: -5,
        freeBytes: Number.NaN,
        needBytes: Infinity,
        retentionDays: null,
        daysStored: undefined,
      }),
    )!;
    expect(n.reservedBytes).toBe(0);
    expect(n.usedBytes).toBe(0);
    expect(n.freeBytes).toBe(0);
    expect(n.needBytes).toBe(0);
    expect(n.retentionDays).toBe(7);
    expect(n.daysStored).toBe(0);
  });

  it("accepts byte counts sent as decimal strings (the ADR-029 BigInt contract)", () => {
    const n = normalizeRecordingStorage(
      fullPayload({ reservedBytes: String(120 * GIB), usedBytes: "0" }),
    )!;
    expect(n.reservedBytes).toBe(120 * GIB);
    expect(n.usedBytes).toBe(0);
  });

  it("tolerates a drive object with only some fields", () => {
    const n = normalizeRecordingStorage(fullPayload({ drive: { label: "Bay 2" } }))!;
    expect(n.drive).toEqual({
      fsUuid: "",
      label: "Bay 2",
      model: "",
      sizeBytes: 0,
      encrypted: false,
      mountPath: "",
    });
  });

  it("treats a non-object drive as no drive", () => {
    expect(normalizeRecordingStorage(fullPayload({ drive: "sdb" }))!.drive).toBeNull();
    expect(normalizeRecordingStorage(fullPayload({ drive: null }))!.drive).toBeNull();
  });

  it("skips malformed camera rows but keeps the good ones", () => {
    const n = normalizeRecordingStorage(
      fullPayload({
        cameras: [
          null,
          "garage",
          { displayName: "no name" },
          { name: "porch", gbPerDay: "n/a" },
          { name: "front_door", displayName: "Front door", gbPerDay: 36 },
        ],
      }),
    )!;
    expect(n.cameras.map((c) => c.name)).toEqual(["porch", "front_door"]);
    // A camera with no displayName falls back to its name.
    expect(n.cameras[0]!.displayName).toBe("porch");
    expect(n.cameras[0]!.gbPerDay).toBe(0);
  });

  it("treats a non-array cameras / warnings / eligibleDrives as empty", () => {
    const n = normalizeRecordingStorage(
      fullPayload({ cameras: {}, warnings: "oops", eligibleDrives: 3 }),
    )!;
    expect(n.cameras).toEqual([]);
    expect(n.warnings).toEqual([]);
    expect(n.eligibleDrives).toEqual([]);
  });

  it("keeps a warning with a code the UI has never heard of", () => {
    const n = normalizeRecordingStorage(
      fullPayload({ warnings: [{ code: "fan_failed", message: "Fan 2 stopped." }] }),
    )!;
    expect(n.warnings).toEqual([{ code: "fan_failed", message: "Fan 2 stopped." }]);
  });

  it("drops warnings with no string code, and defaults a missing message", () => {
    const n = normalizeRecordingStorage(
      fullPayload({ warnings: [{ message: "x" }, null, { code: "near_full" }] }),
    )!;
    expect(n.warnings).toEqual([{ code: "near_full", message: "" }]);
  });

  it("skips eligible drives with no fsUuid (they could never be chosen)", () => {
    const n = normalizeRecordingStorage(
      fullPayload({
        eligibleDrives: [{ label: "ghost" }, { fsUuid: "ok-1", label: "Real" }],
      }),
    )!;
    expect(n.eligibleDrives.map((d) => d.fsUuid)).toEqual(["ok-1"]);
  });

  it("clamps migration progress to 0–100 and validates its state", () => {
    const hi = normalizeRecordingStorage(
      fullPayload({ migration: { state: "running", progressPct: 180, bytesCopied: 5 } }),
    )!;
    expect(hi.migration.progressPct).toBe(100);
    expect(hi.migration.state).toBe("running");
    expect(hi.migration.bytesCopied).toBe(5);
    const lo = normalizeRecordingStorage(
      fullPayload({ migration: { state: "exploded", progressPct: -3 } }),
    )!;
    expect(lo.migration.progressPct).toBe(0);
    expect(lo.migration.state).toBe("idle");
  });

  it("keeps a migration error message and start time", () => {
    const n = normalizeRecordingStorage(
      fullPayload({
        migration: {
          state: "failed",
          progressPct: 12,
          startedAt: "2026-10-03T10:00:00Z",
          error: "rsync exited 23",
        },
      }),
    )!;
    expect(n.migration.startedAt).toBe("2026-10-03T10:00:00Z");
    expect(n.migration.error).toBe("rsync exited 23");
  });

  it("keeps old footage and defaults its location", () => {
    const n = normalizeRecordingStorage(
      fullPayload({ oldFootage: { present: true, bytes: 12 * GIB } }),
    )!;
    expect(n.oldFootage).toEqual({ present: true, bytes: 12 * GIB, location: "system_disk" });
  });
});

describe("recordingStatusView", () => {
  it.each([
    ["active", "Active", "ok"],
    ["pending", "Setting up", "info"],
    ["migrating", "Moving recordings", "info"],
    ["degraded", "Needs attention", "warn"],
    ["missing", "Drive missing", "danger"],
    ["no_eligible_drive", "No drive yet", "muted"],
    ["on_system_disk", "On the system drive", "danger"],
    ["unknown", "Unknown", "muted"],
  ] as const)("%s -> %s (%s)", (status, label, kind) => {
    expect(recordingStatusView(status)).toEqual({ label, kind });
  });
});

describe("recordingsDriveName", () => {
  it("prefers the label, then the model, then a friendly generic", () => {
    expect(recordingsDriveName({ label: "Bay 2", model: "WD Red" })).toBe("Bay 2");
    expect(recordingsDriveName({ label: "", model: "WD Red" })).toBe("WD Red");
    expect(recordingsDriveName({ label: " ", model: "" })).toBe("Drive");
    expect(recordingsDriveName(null)).toBe("Drive");
  });
});

describe("cameraNeedShares", () => {
  it("shares each camera's need of the total, summing to ~100", () => {
    const rows = cameraNeedShares([
      { name: "a", displayName: "A", mbPerHour: 1, gbPerDay: 1, needBytes: 75, usedBytes: 0 },
      { name: "b", displayName: "B", mbPerHour: 1, gbPerDay: 1, needBytes: 25, usedBytes: 0 },
    ]);
    expect(rows.map((r) => r.sharePct)).toEqual([75, 25]);
  });

  it("is 0 for everyone when nobody has a measured need yet", () => {
    const rows = cameraNeedShares([
      { name: "a", displayName: "A", mbPerHour: 0, gbPerDay: 0, needBytes: 0, usedBytes: 0 },
    ]);
    expect(rows[0]!.sharePct).toBe(0);
  });

  it("returns an empty list for no cameras", () => {
    expect(cameraNeedShares([])).toEqual([]);
  });
});

describe("formatRate — MB/h and GB/day", () => {
  it.each([
    [1500, "1500"],
    [1500.4, "1500"],
    [100, "100"],
    [36, "36"],
    [16.84, "16.8"],
    [0.5, "0.5"],
    [0.04, "<0.1"],
    [0, "0"],
    [-3, "0"],
    [Number.NaN, "0"],
    [Infinity, "0"],
  ])("%s -> %s", (n, expected) => {
    expect(formatRate(n)).toBe(expected);
  });
});

describe("describeWarning — every contract code maps to a title and a fix", () => {
  const ctx = { mode: "auto_reserved" as const, eligibleCount: 0, retentionDays: 7 };

  it("drive_missing -> danger, fix = open Storage", () => {
    const v = describeWarning({ code: "drive_missing", message: "" }, ctx);
    expect(v.severity).toBe("danger");
    expect(v.title).toMatch(/recording drive/i);
    expect(v.fix).toEqual({
      kind: "link",
      label: "Open Storage",
      href: SETTINGS_STORAGE_HREF,
    });
  });

  it("read_only -> danger, fix = open Storage", () => {
    const v = describeWarning({ code: "read_only", message: "" }, ctx);
    expect(v.severity).toBe("danger");
    expect(v.title).toMatch(/read-only/i);
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("near_full on an auto-sized slice -> warn, fix = use the whole drive", () => {
    const v = describeWarning({ code: "near_full", message: "" }, ctx);
    expect(v.severity).toBe("warn");
    expect(v.title).toMatch(/nearly full/i);
    expect(v.fix).toEqual({ kind: "whole_drive", label: "Use the whole drive" });
  });

  it("near_full when already on the whole drive -> fix = open Storage (no further to grow)", () => {
    const v = describeWarning(
      { code: "near_full", message: "" },
      { ...ctx, mode: "full" as const },
    );
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("cannot_grow -> warn, fix = open Storage (more room is needed, not a bigger share)", () => {
    const v = describeWarning({ code: "cannot_grow", message: "" }, ctx);
    expect(v.severity).toBe("warn");
    expect(v.title).toMatch(/can.t grow/i);
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("on_system_disk -> danger, fix = open Storage to set up a recording drive", () => {
    const v = describeWarning({ code: "on_system_disk", message: "" }, ctx);
    expect(v.severity).toBe("danger");
    expect(v.title).toMatch(/system drive/i);
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("on_system_disk with an eligible drive on hand -> fix = pick it", () => {
    const v = describeWarning(
      { code: "on_system_disk", message: "" },
      { ...ctx, eligibleCount: 1 },
    );
    expect(v.fix).toEqual({ kind: "pick_drive", label: "Choose a recording drive" });
  });

  it("smart_failed -> danger, fix = open Storage", () => {
    const v = describeWarning({ code: "smart_failed", message: "" }, ctx);
    expect(v.severity).toBe("danger");
    expect(v.title).toMatch(/health/i);
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("not_encrypted -> warn, fix = open Storage to prepare a drive", () => {
    const v = describeWarning({ code: "not_encrypted", message: "" }, ctx);
    expect(v.severity).toBe("warn");
    expect(v.title).toMatch(/encrypted/i);
    expect(v.fix).toMatchObject({ kind: "link", href: SETTINGS_STORAGE_HREF });
  });

  it("an unknown code still renders — the server's own message, no fix", () => {
    const v = describeWarning({ code: "fan_failed", message: "Fan 2 stopped." }, ctx);
    expect(v.code).toBe("fan_failed");
    expect(v.severity).toBe("warn");
    expect(v.title).toMatch(/needs attention/i);
    expect(v.detail).toBe("Fan 2 stopped.");
    expect(v.fix).toBeNull();
  });

  it("carries the server message as a secondary line for a known code, only when it adds something", () => {
    const withMsg = describeWarning(
      { code: "near_full", message: "Only 4 GiB left on Bay 2." },
      ctx,
    );
    expect(withMsg.serverMessage).toBe("Only 4 GiB left on Bay 2.");
    const empty = describeWarning({ code: "near_full", message: "" }, ctx);
    expect(empty.serverMessage).toBeNull();
  });

  it("mentions the retention window in the near-full detail", () => {
    const v = describeWarning({ code: "near_full", message: "" }, { ...ctx, retentionDays: 14 });
    expect(v.detail).toMatch(/14 days/);
  });
});

describe("friendlyRecordingStorageError", () => {
  const err = (status: number, message = "raw server text") =>
    Object.assign(new Error(message), { status });

  it("never echoes the server's raw text", () => {
    const text = friendlyRecordingStorageError(err(500, "rsync: exit 23 /dev/sdb1"), "mode");
    expect(text).not.toMatch(/rsync|sdb1/);
  });

  it("explains a 403 as an owner/admin matter", () => {
    expect(friendlyRecordingStorageError(err(403), "mode")).toMatch(/owner or an admin/i);
  });

  it("explains a delete 403 as an owner-only matter", () => {
    expect(friendlyRecordingStorageError(err(403), "delete-old")).toMatch(/owner/i);
  });

  it("explains a 409 on a mode/drive change as 'a move is already running / not now'", () => {
    expect(friendlyRecordingStorageError(err(409), "mode")).toMatch(/right now|already|moving/i);
  });

  it("explains a 409 on deleting old footage as 'wait for the move'", () => {
    expect(friendlyRecordingStorageError(err(409), "delete-old")).toMatch(/move|finish/i);
  });

  it("explains a 404 as 'not available on this Droplet yet'", () => {
    expect(friendlyRecordingStorageError(err(404), "mode")).toMatch(/isn.t available/i);
  });

  it("has a calm generic fallback", () => {
    expect(friendlyRecordingStorageError(new Error("boom"), "mode")).toMatch(/try again/i);
    expect(friendlyRecordingStorageError("weird", "delete-old")).toMatch(/try again/i);
  });
});

describe("link targets", () => {
  it("points at the Settings → Storage page and the system-page card anchor", () => {
    expect(SETTINGS_STORAGE_HREF).toBe("/settings/storage");
    expect(RECORDING_STORAGE_HREF).toBe("/cameras/system#recording-storage");
  });
});

describe("effectiveRecordingStatus — missing > migrating > degraded > on_system_disk > pending > active > no_eligible_drive", () => {
  const migrating = { state: "running" as const, progressPct: 5, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null };
  const idle = { state: "idle" as const, progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null };
  const eff = (
    status: Parameters<typeof effectiveRecordingStatus>[0]["status"],
    codes: string[] = [],
    migration: RecordingStorage["migration"] = idle,
  ) =>
    effectiveRecordingStatus({
      status,
      warnings: codes.map((code) => ({ code, message: "" })),
      migration,
    });

  it("trusts the status when nothing contradicts it", () => {
    for (const s of ["missing", "migrating", "degraded", "on_system_disk", "pending", "active", "no_eligible_drive"] as const) {
      expect(eff(s)).toBe(s);
    }
  });

  it("a missing drive outranks everything else", () => {
    expect(eff("active", ["drive_missing"])).toBe("missing");
    expect(eff("migrating", ["drive_missing"])).toBe("missing");
    expect(eff("degraded", ["drive_missing"], migrating)).toBe("missing");
  });

  it("a move in flight outranks degraded, on-the-system-drive, pending and active", () => {
    expect(eff("active", [], migrating)).toBe("migrating");
    expect(eff("pending", [], migrating)).toBe("migrating");
    expect(eff("degraded", [], migrating)).toBe("migrating");
    expect(eff("on_system_disk", [], migrating)).toBe("migrating");
  });

  it("a failing drive (read-only, SMART, cannot grow) is degraded even when the status says active", () => {
    expect(eff("active", ["read_only"])).toBe("degraded");
    expect(eff("active", ["smart_failed"])).toBe("degraded");
    expect(eff("pending", ["cannot_grow"])).toBe("degraded");
    expect(eff("on_system_disk", ["read_only"])).toBe("degraded");
  });

  it("near-full alone does not change the status (it is a warning, not a state)", () => {
    expect(eff("active", ["near_full"])).toBe("active");
  });

  it("on the system drive outranks pending, active and no-eligible-drive", () => {
    expect(eff("pending", ["on_system_disk"])).toBe("on_system_disk");
    expect(eff("active", ["on_system_disk"])).toBe("on_system_disk");
    expect(eff("no_eligible_drive", ["on_system_disk"])).toBe("on_system_disk");
  });

  it("an unrecognised status yields to any recognised signal, and stays unknown otherwise", () => {
    expect(eff("unknown")).toBe("unknown");
    expect(eff("unknown", ["drive_missing"])).toBe("missing");
    expect(eff("unknown", [], migrating)).toBe("migrating");
  });
});

describe("isWholeDriveBlockedByFiles — Whole drive is only allowed on a drive whose files/ is empty", () => {
  const err = (status: number, message: string, code?: string) =>
    Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

  it.each(["files_not_empty", "drive_has_files", "files_present"])("recognises the code %s", (code) => {
    expect(isWholeDriveBlockedByFiles(err(409, "x", code))).toBe(true);
  });

  it.each([
    "files/ is not empty",
    "The drive still holds files",
    "drive has files in files/",
    "Cannot use the whole drive: files present",
  ])("recognises 409 prose: %s", (message) => {
    expect(isWholeDriveBlockedByFiles(err(409, message))).toBe(true);
  });

  it.each([
    err(409, "migration running"),
    err(409, "drive busy"),
    err(500, "files/ is not empty"),
    err(403, "no"),
    new Error("files/ is not empty"),
    null,
    "files_not_empty",
  ])("is false for %o", (value) => {
    expect(isWholeDriveBlockedByFiles(value)).toBe(false);
  });

  it("friendlyRecordingStorageError explains it, and says where the files are", () => {
    const text = friendlyRecordingStorageError(err(409, "files/ is not empty"), "mode");
    expect(text).toMatch(/holds no files|no files on it/i);
    expect(text).toMatch(/move your files off/i);
  });
});

describe("friendlyRecordingStorageError — regenerate", () => {
  const err = (status: number) => Object.assign(new Error("raw"), { status });

  it("403 is an owner-only matter", () => {
    expect(friendlyRecordingStorageError(err(403), "regenerate")).toMatch(/only the droplet's owner/i);
  });

  it("409 says now is not the moment", () => {
    expect(friendlyRecordingStorageError(err(409), "regenerate")).toMatch(/right now/i);
  });

  it("404 says it is not available yet", () => {
    expect(friendlyRecordingStorageError(err(404), "regenerate")).toMatch(/isn.t available/i);
  });
});

describe("MIGRATION_RETRY_COPY — the failed-move retry schedule", () => {
  it("names the 1 h / 6 h / 24 h schedule, in order", () => {
    expect(MIGRATION_RETRY_COPY).toMatch(/1 hour.*6 hours.*24 hours/);
  });
});

describe("oldFootagePlace — where the old recordings are", () => {
  it("the system drive, for the usual first move", () => {
    expect(oldFootagePlace("system_disk")).toEqual({
      where: "the system drive",
      action: "Delete old recordings from system drive",
      summary: "system drive",
    });
  });

  it("the previous recording drive, when a move left them on a bay drive", () => {
    for (const location of ["bay_drive", "fs-uuid-9", "Bay 3"]) {
      expect(oldFootagePlace(location)).toEqual({
        where: "the previous recording drive",
        action: "Delete old recordings from previous drive",
        summary: "previous drive",
      });
    }
  });
});
