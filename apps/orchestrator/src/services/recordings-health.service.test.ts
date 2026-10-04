import { describe, expect, it, vi } from "vitest";
import { createRecordingsHealthCheck, RECORDINGS_ALERT_TITLES } from "./recordings-health.service.js";
import { GIB } from "./recordings-sizing.js";
import type { AllocationRecord, NvrHostStatus, RecordingsDriveCandidate, RecordingsFacts } from "./recordings.types.js";

const T0 = new Date("2026-10-03T12:00:00.000Z");
const FS = "aaaaaaaa-0000-0000-0000-000000000001";
const g = (n: number): number => n * GIB;

const allocation = (over: Partial<AllocationRecord> = {}): AllocationRecord => ({
  id: "r1", fsUuid: FS, mode: "AUTO_RESERVED", reservedBytes: g(100), status: "ACTIVE", migrationFailures: 0,
  lastFailureAt: null, createdAt: T0, updatedAt: T0, ...over,
});
const drive = (over: Partial<RecordingsDriveCandidate> = {}): RecordingsDriveCandidate => ({
  fsUuid: FS, label: "L", model: "M", sizeBytes: g(1000), usedBytes: g(100), freeBytes: g(900), mountPath: "/mnt/droplet/x",
  mounted: true, readOnly: false, fsType: "ext4", encryption: "luks2", preparation: "prepared", isSystemDisk: false,
  smart: "PASSED", parentDisk: "sdb", ...over,
});
const bayHost = (over: Partial<NvrHostStatus> = {}): NvrHostStatus => ({
  source: "/mnt/droplet/x/nvr", kind: "path", fsUuid: FS, mountPath: "/mnt/droplet/x", physicalDisk: "sdb", backingDevices: [],
  isSystemDisk: false, encrypted: true, mounted: true, rw: true, projectId: 4096, limitBytes: g(100), usedBytes: g(10),
  fsSizeBytes: g(1000), fsFreeBytes: g(800), ...over,
});
const volumeHost = (): NvrHostStatus => ({
  ...bayHost(), source: "nvrdata", kind: "volume", fsUuid: null, mountPath: null, isSystemDisk: true, projectId: null,
});

function facts(over: Partial<RecordingsFacts> = {}): RecordingsFacts {
  const a = "allocation" in over ? over.allocation ?? null : allocation();
  return {
    at: T0, allocation: a, allocations: a ? [a] : [], host: bayHost(), hostError: null, migration: null,
    drives: [drive()], drivesError: null, frigate: null,
    sizing: { retentionDays: 7, cameras: [], sumBytes: g(20), needTotalBytes: g(20) }, cameraNames: {}, ...over,
  };
}

type State = { code: string; active: boolean; since: Date | null; notifiedAt: Date | null };
function harness(initial: State[] = []) {
  const states = new Map(initial.map((s) => [s.code, { ...s, updatedAt: T0 }]));
  const recordingsAlertState = {
    findMany: vi.fn(async () => [...states.values()]),
    upsert: vi.fn(async (a: { where: { code: string }; create: State; update: Partial<State> }) => {
      const cur = states.get(a.where.code);
      states.set(a.where.code, { ...(cur ?? a.create), ...(cur ? a.update : {}), updatedAt: T0 } as never);
    }),
    update: vi.fn(async (a: { where: { code: string }; data: Partial<State> }) => {
      states.set(a.where.code, { ...states.get(a.where.code)!, ...a.data });
    }),
  };
  const notifyOwners = vi.fn(async (_t: string, _b: string) => ({ notified: ["owner"] }));
  let current = facts();
  let clock = T0;
  const check = createRecordingsHealthCheck({
    prisma: { recordingsAlertState } as never, collectFacts: async () => current, notifyOwners, now: () => clock,
  });
  return {
    check, notifyOwners, states, recordingsAlertState,
    set: (f: RecordingsFacts) => { current = f; },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
  };
}

describe("recordings health check (WARP-3514)", () => {
  it("a healthy box raises nothing and writes nothing", async () => {
    const h = harness();
    expect(await h.check.runOnce()).toEqual({ raised: [], cleared: [], skipped: false });
    expect(h.notifyOwners).not.toHaveBeenCalled();
    expect(h.recordingsAlertState.upsert).not.toHaveBeenCalled();
  });

  it("recordings on the OS disk raise on_system_disk EVEN WITH ZERO CAMERAS and no allocation", async () => {
    const h = harness();
    h.set(facts({ allocation: null, host: volumeHost(), drives: [], sizing: { retentionDays: 7, cameras: [], sumBytes: 0, needTotalBytes: g(20) } }));
    const r = await h.check.runOnce();
    expect(r.raised).toEqual(["on_system_disk"]);
    expect(h.notifyOwners).toHaveBeenCalledWith(RECORDINGS_ALERT_TITLES.on_system_disk, expect.stringContaining("system disk"));
  });

  it.each([
    ["drive_missing", () => facts({ drives: [] })],
    ["read_only", () => facts({ drives: [drive({ readOnly: true })] })],
    ["smart_failed", () => facts({ drives: [drive({ smart: "FAILED" })] })],
    ["not_encrypted", () => facts({ drives: [drive({ encryption: "none" })] })],
    ["near_full", () => facts({ host: bayHost({ usedBytes: g(90) }) })],
  ] as const)("%s is raised once", async (code, build) => {
    const h = harness();
    h.set(build());
    expect((await h.check.runOnce()).raised).toContain(code);
    expect(h.notifyOwners.mock.calls.map((c) => c[0])).toContain(RECORDINGS_ALERT_TITLES[code]);
  });

  it("cannot_grow is raised when the need cannot be met", async () => {
    const h = harness();
    h.set(facts({ host: bayHost({ usedBytes: g(95), fsFreeBytes: 0 }), sizing: { retentionDays: 7, cameras: [], sumBytes: g(130), needTotalBytes: g(130) } }));
    expect((await h.check.runOnce()).raised).toContain("cannot_grow");
  });

  it("ONE notification per outage across many ticks; the state survives (it is in the DB, not in memory)", async () => {
    const h = harness();
    h.set(facts({ drives: [] }));
    await h.check.runOnce();
    h.advance(3_600_000);
    await h.check.runOnce();
    h.advance(3_600_000);
    await h.check.runOnce();
    expect(h.notifyOwners).toHaveBeenCalledTimes(1);
    expect(h.states.get("DRIVE_MISSING")).toMatchObject({ active: true, since: T0, notifiedAt: T0 });
  });

  it("recovery clears the outage; the NEXT outage is announced again", async () => {
    const h = harness();
    h.set(facts({ drives: [] }));
    await h.check.runOnce();
    h.set(facts());
    expect((await h.check.runOnce()).cleared).toEqual(["drive_missing"]);
    expect(h.states.get("DRIVE_MISSING")).toMatchObject({ active: false, since: null, notifiedAt: null });
    h.set(facts({ drives: [] }));
    await h.check.runOnce();
    expect(h.notifyOwners).toHaveBeenCalledTimes(2);
  });

  it("an announced outage already in the DB is not announced again after a restart", async () => {
    const h = harness([{ code: "DRIVE_MISSING", active: true, since: T0, notifiedAt: T0 }]);
    h.set(facts({ drives: [] }));
    expect((await h.check.runOnce()).raised).toEqual([]);
    expect(h.notifyOwners).not.toHaveBeenCalled();
  });

  it("when nobody could be notified the outage is retried next hour (notifiedAt stays null)", async () => {
    const h = harness();
    h.notifyOwners.mockResolvedValueOnce({ notified: [] });
    h.set(facts({ drives: [] }));
    await h.check.runOnce();
    expect(h.states.get("DRIVE_MISSING")).toMatchObject({ active: true, notifiedAt: null });
    await h.check.runOnce();
    expect(h.notifyOwners).toHaveBeenCalledTimes(2);
    expect(h.states.get("DRIVE_MISSING")?.notifiedAt).toEqual(T0);
  });

  it("an unreachable bridge changes NOTHING — not an outage, not a recovery", async () => {
    const h = harness([{ code: "DRIVE_MISSING", active: true, since: T0, notifiedAt: T0 }]);
    h.set(facts({ hostError: "down", host: null }));
    expect(await h.check.runOnce()).toEqual({ raised: [], cleared: [], skipped: true });
    expect(h.states.get("DRIVE_MISSING")?.active).toBe(true);
    expect(h.recordingsAlertState.update).not.toHaveBeenCalled();
  });

  it("alert texts carry no label and no mount path", async () => {
    const h = harness();
    h.set(facts({ drives: [drive({ readOnly: true, smart: "FAILED", encryption: "none", label: "SECRET-LABEL" })], host: bayHost({ usedBytes: g(95) }) }));
    await h.check.runOnce();
    expect(JSON.stringify(h.notifyOwners.mock.calls)).not.toMatch(/SECRET-LABEL|\/mnt\//);
  });
});
