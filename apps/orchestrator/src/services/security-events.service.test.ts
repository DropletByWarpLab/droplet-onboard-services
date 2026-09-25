/**
 * WARP-2977 (ADR-059 §3.3, §6, §7) — the Security event store, mocked lane.
 *
 * What a mocked Prisma can prove: which statements run, with what `where`,
 * in what order. What it cannot — that `skipDuplicates` really absorbs a
 * redelivery, and that the visibility `where` really hides a camera — is
 * proven against Postgres in security-events.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// WARP-2978 — the retention leg hands the SAME `before` to the incident trim.
const incidentTrim = vi.hoisted(() => vi.fn(async () => ({ marked: 0, deleted: 0 })));
vi.mock("./security-incidents.service.js", () => ({ trimSecurityIncidents: incidentTrim }));

import {
  buildSecurityHealth,
  createStatusTracker,
  feedVisibilityWhere,
  listSecurityEvents,
  mirrorThreatRows,
  noteFrigateSubscription,
  parseFeedCursor,
  recordSecurityEvent,
  registerSecurityJobs,
  securityIngestHealthState,
  trimSecurityEvents,
  writeSecurityEvent,
  _resetSecurityIngestHealthForTests,
  SECURITY_EVENT_RETENTION_DAYS,
  SECURITY_RETENTION_CRON,
  SECURITY_RETENTION_LOCK_KEY,
  SECURITY_THREAT_MIRROR_INTERVAL_MS,
  SECURITY_THREAT_MIRROR_LOCK_KEY,
} from "./security-events.service.js";
import type { SecurityEventDraft } from "./security-event-ingest.js";

const NOW = new Date("2026-09-23T02:14:00Z");

function draft(over: Partial<SecurityEventDraft> = {}): SecurityEventDraft {
  return {
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: "front_door",
    sourceRef: "front_door/e1",
    dedupeKey: "frigate:e1",
    labels: ["person"],
    cameraZones: [],
    score: 0.9,
    startedAt: NOW,
    endedAt: NOW,
    summary: "Person",
    observed: "live",
    ...over,
  };
}

/** A lock_state row as the lock adapter writes it. */
function lockDraft(over: Partial<SecurityEventDraft> = {}): SecurityEventDraft {
  return draft({
    source: "matter_lock",
    kind: "lock_state",
    camera: null,
    sourceRef: "matter:7/1",
    dedupeKey: "matter_lock:7/1:after:none:unlocked",
    labels: ["unlocked"],
    score: null,
    endedAt: null,
    summary: "Back door lock: unlocked",
    ...over,
  });
}

beforeEach(() => {
  _resetSecurityIngestHealthForTests();
});

describe("recordSecurityEvent — the one writer", () => {
  it("writes with skipDuplicates and reports whether a row landed", async () => {
    const createMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const prisma = { securityEvent: { createMany } } as never;
    expect(await recordSecurityEvent(prisma, draft())).toBe(true);
    expect(await recordSecurityEvent(prisma, draft())).toBe(false);
    expect(createMany).toHaveBeenCalledWith({ data: [draft()], skipDuplicates: true });
  });

  it("never throws — a failed write is recorded for the health header, under its source", async () => {
    const prisma = { securityEvent: { createMany: vi.fn().mockRejectedValue(new Error("pool exhausted")) } } as never;
    await expect(recordSecurityEvent(prisma, draft())).resolves.toBe(false);
    expect(securityIngestHealthState().lastWriteError.get("frigate")?.message).toBe("pool exhausted");
  });
});

describe("writeSecurityEvent — the same writer, telling a duplicate from a failure (WARP-2977 P2b-2)", () => {
  it("recorded / duplicate / failed — the lock adapter moves its memory only on the first two", async () => {
    const createMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error("pool exhausted"));
    const prisma = { securityEvent: { createMany } } as never;
    expect(await writeSecurityEvent(prisma, lockDraft())).toBe("recorded");
    expect(await writeSecurityEvent(prisma, lockDraft())).toBe("duplicate");
    expect(await writeSecurityEvent(prisma, lockDraft())).toBe("failed");
    expect(createMany).toHaveBeenCalledWith({ data: [lockDraft()], skipDuplicates: true });
  });

  it("a duplicate is neither a save nor a failure in the write health", async () => {
    const prisma = { securityEvent: { createMany: vi.fn().mockResolvedValue({ count: 0 }) } } as never;
    await writeSecurityEvent(prisma, draft());
    expect(securityIngestHealthState().lastRecordedAt.size).toBe(0);
    expect(securityIngestHealthState().lastWriteError.size).toBe(0);
  });
});

describe("write health is per SOURCE (WARP-2977 P2b-2) — one source's save never clears another's failure", () => {
  const healthy = {
    frigateConfigured: true,
    frigate: { health: "online" as const, at: NOW },
    state: { threatMirrorRanAt: NOW, retentionRanAt: NOW, retentionDeleted: 0 },
    now: NOW,
  };
  const cameraIngest = () =>
    buildSecurityHealth({
      ...healthy,
      ingest: { ...securityIngestHealthState(), frigateSubscribed: true, frigateSubscribedAt: NOW, lastFrigateMessageAt: NOW, jobsRegistered: true },
    }).find((r) => r.id === "camera_ingest")!;

  it("a lock write after a Frigate write failure leaves camera_ingest down", async () => {
    const createMany = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({ count: 1 });
    const prisma = { securityEvent: { createMany } } as never;
    await recordSecurityEvent(prisma, draft());
    await writeSecurityEvent(prisma, lockDraft());
    expect(securityIngestHealthState().lastRecordedAt.has("matter_lock")).toBe(true);
    expect(cameraIngest()).toMatchObject({ state: "down", detail: "Camera events are arriving but could not be saved" });
  });

  it("a camera-status save does not clear a failed detection save either; a detection save does", async () => {
    const createMany = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue({ count: 1 });
    const prisma = { securityEvent: { createMany } } as never;
    await recordSecurityEvent(prisma, draft());
    await recordSecurityEvent(
      prisma,
      draft({ source: "frigate_status", kind: "camera_online", sourceRef: "front_door/status/detect", dedupeKey: "frigate_status:x" }),
    );
    expect(cameraIngest().state).toBe("down");
    await recordSecurityEvent(prisma, draft({ dedupeKey: "frigate:e2" }));
    expect(cameraIngest().state).toBe("ok");
  });

  it("a failed LOCK write never turns camera_ingest down", async () => {
    const prisma = { securityEvent: { createMany: vi.fn().mockRejectedValue(new Error("disk full")) } } as never;
    await writeSecurityEvent(prisma, lockDraft());
    expect(securityIngestHealthState().lastWriteError.get("matter_lock")?.message).toBe("disk full");
    expect(cameraIngest().state).toBe("ok");
  });

  // Review F1: camera STATUS write health is "the status tracker still holds a
  // row it could not save", not "the last status error is newer than the last
  // status save" — status rows are rare, so the latter could stick for weeks.
  describe("camera status rows: down exactly while the tracker holds an unsaved row", () => {
    function statusStore(previousKind: string) {
      const createMany = vi.fn().mockResolvedValue({ count: 1 });
      const findFirst = vi.fn().mockResolvedValue({ kind: previousKind });
      return { t: createStatusTracker({ securityEvent: { createMany, findFirst } } as never), createMany };
    }

    it("a failed status write, then the camera back in its stored state: nothing is left to save → ok", async () => {
      const { t, createMany } = statusStore("camera_online");
      createMany.mockRejectedValueOnce(new Error("disk full"));
      await t.observe("frigate/cam1/status/detect", "offline", NOW);
      expect(cameraIngest()).toMatchObject({ state: "down", detail: "Camera events are arriving but could not be saved" });
      // Back to the state the store already holds: the queued offline row is dropped, nothing is owed.
      await t.observe("frigate/cam1/status/detect", "online", new Date(NOW.getTime() + 60_000));
      expect(cameraIngest().state).toBe("ok");
    });

    it("a failed status write, then its retry lands → ok", async () => {
      const { t, createMany } = statusStore("camera_online");
      createMany.mockRejectedValueOnce(new Error("disk full"));
      await t.observe("frigate/cam1/status/detect", "offline", NOW);
      expect(cameraIngest().state).toBe("down");
      await t.observe("frigate/cam1/status/detect", "offline", new Date(NOW.getTime() + 60_000));
      expect(cameraIngest().state).toBe("ok");
    });

    it("a retry that already landed (a duplicate) counts as saved — stored, nothing queued, ok", async () => {
      const { t, createMany } = statusStore("camera_online");
      createMany.mockResolvedValueOnce({ count: 0 });
      const r = await t.observe("frigate/cam1/status/detect", "offline", NOW);
      expect(r?.stored).toBe(true);
      expect(cameraIngest().state).toBe("ok");
      // …and the next reading does not re-send it.
      await t.observe("frigate/cam1/status/detect", "offline", new Date(NOW.getTime() + 60_000));
      expect(createMany).toHaveBeenCalledTimes(1);
    });

    it("one camera's unsaved row is not cleared by another camera's save", async () => {
      const { t, createMany } = statusStore("camera_online");
      createMany.mockRejectedValueOnce(new Error("disk full"));
      await t.observe("frigate/cam1/status/detect", "offline", NOW);
      await t.observe("frigate/cam2/status/detect", "offline", NOW);
      expect(createMany).toHaveBeenCalledTimes(2);
      expect(cameraIngest().state).toBe("down");
    });
  });
});

describe("createStatusTracker — transitions only, previous read back from the store", () => {
  function tracker(previousKind: string | null) {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue(previousKind ? { kind: previousKind } : null);
    return { t: createStatusTracker({ securityEvent: { createMany, findFirst } } as never), createMany, findFirst };
  }

  it("reads the store once per camera, then remembers", async () => {
    const { t, findFirst } = tracker("camera_online");
    await t.observe("frigate/cam1/status/detect", "online", NOW);
    await t.observe("frigate/cam1/status/detect", "online", NOW);
    await t.observe("frigate/cam2/status/detect", "online", NOW);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[0][0].where).toEqual({ source: "frigate_status", camera: "cam1" });
  });

  it("a restart does not re-announce a camera that was already offline", async () => {
    const { t, createMany } = tracker("camera_offline");
    expect(await t.observe("frigate/cam1/status/detect", "offline", NOW)).toEqual({ broadcast: null, stored: null });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("offline then online a moment apart are applied in order — two rows, offline first", async () => {
    const { t, createMany, findFirst } = tracker("camera_online");
    // Slow first lookup: without the per-camera chain the `online` reading
    // would resolve first against the same stale "online" and record nothing.
    findFirst.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ kind: "camera_online" }), 20)),
    );
    const a = t.observe("frigate/cam1/status/detect", "offline", NOW);
    const b = t.observe("frigate/cam1/status/detect", "online", new Date(NOW.getTime() + 1));
    await Promise.all([a, b]);
    expect(createMany.mock.calls.map(([{ data }]) => data[0].kind)).toEqual(["camera_offline", "camera_online"]);
  });

  it("a failed lookup is treated as first sight — an offline camera is still recorded", async () => {
    const { t, createMany, findFirst } = tracker(null);
    findFirst.mockRejectedValueOnce(new Error("db down"));
    const r = await t.observe("frigate/cam1/status/detect", "offline", NOW);
    expect(r?.broadcast?.kind).toBe("camera_offline");
    expect(r?.stored).toBe(true);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("a failed store write still reports the transition — the live surface must not depend on the database", async () => {
    const { t, createMany } = tracker("camera_online");
    createMany.mockRejectedValueOnce(new Error("db down"));
    const r = await t.observe("frigate/cam1/status/detect", "offline", NOW);
    expect(r).toMatchObject({ broadcast: { kind: "camera_offline", camera: "cam1" }, stored: false });
  });

  it("a failed write is retried on the next reading, with its ORIGINAL time — and broadcast only once", async () => {
    const { t, createMany } = tracker("camera_online");
    createMany.mockRejectedValueOnce(new Error("db down"));
    await t.observe("frigate/cam1/status/detect", "offline", NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const again = await t.observe("frigate/cam1/status/detect", "offline", later);
    expect(again).toEqual({ broadcast: null, stored: true });
    const [first, retry] = createMany.mock.calls.map(([{ data }]) => data[0]);
    expect(retry.dedupeKey).toBe(first.dedupeKey);
    expect(retry.startedAt).toEqual(NOW);
  });

  it("an offline that never reached the store is not followed by a lone 'reporting again' row", async () => {
    const { t, createMany } = tracker("camera_online");
    createMany.mockRejectedValueOnce(new Error("db down"));
    await t.observe("frigate/cam1/status/detect", "offline", NOW);
    const back = await t.observe("frigate/cam1/status/detect", "online", new Date(NOW.getTime() + 1_000));
    // The dashboard hears the recovery; the store, which never saw the
    // outage, records nothing rather than a recovery from nothing.
    expect(back).toEqual({ broadcast: expect.objectContaining({ kind: "camera_online" }), stored: null });
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("the snapshot carries the latest reading, including Frigate's own (null key)", async () => {
    const { t } = tracker(null);
    await t.observe("frigate/available", "online", NOW);
    expect(t.snapshot().get(null)).toEqual({ health: "online", at: NOW, since: NOW });
  });

  it("WARP-2980: `since` is when the health last CHANGED — a repeated reading moves `at`, never `since`", async () => {
    const { t } = tracker("camera_online");
    const later = new Date(NOW.getTime() + 60_000);
    const muchLater = new Date(NOW.getTime() + 120_000);
    await t.observe("frigate/cam1/status/detect", "online", NOW);
    await t.observe("frigate/cam1/status/detect", "online", later);
    expect(t.snapshot().get("cam1")).toEqual({ health: "online", at: later, since: NOW });
    // A change moves both.
    await t.observe("frigate/cam1/status/detect", "offline", muchLater);
    expect(t.snapshot().get("cam1")).toEqual({ health: "offline", at: muchLater, since: muchLater });
    // A retained replay of the same health after a reconnect does not move `since`
    // (the reconnect is caught by frigateSubscribedAt, not here).
    const replay = new Date(NOW.getTime() + 180_000);
    await t.observe("frigate/cam1/status/detect", "offline", replay);
    expect(t.snapshot().get("cam1")).toEqual({ health: "offline", at: replay, since: muchLater });
  });

  it("a topic that is not a status topic does nothing", async () => {
    const { t, findFirst } = tracker(null);
    expect(await t.observe("frigate/cam1/status/record", "offline", NOW)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("mirrorThreatRows — the cursor, the filter, the horizon", () => {
  /** `head` is the chain's max ActivityRow id (every kind, not only threats). */
  function mirrorPrisma(rows: Array<{ id: bigint; kind: string; severity: string }>, cursor = 0n, head: bigint | null = null) {
    const maxRead = rows.length > 0 ? rows[rows.length - 1].id : cursor;
    return {
      securityIngestState: {
        upsert: vi.fn().mockResolvedValue({ threatCursor: cursor }),
        update: vi.fn().mockResolvedValue({}),
      },
      activityRow: {
        aggregate: vi.fn().mockResolvedValue({ _max: { id: head ?? maxRead } }),
        findMany: vi.fn().mockResolvedValue(rows.map((r) => ({ ...r, at: NOW, what: `row ${r.id}` }))),
      },
      securityEvent: { createMany: vi.fn().mockResolvedValue({ count: rows.length }) },
    };
  }

  it("reads only warn/err network/auth rows after the cursor and inside the retention horizon", async () => {
    const p = mirrorPrisma([], 41n, 90n);
    await mirrorThreatRows(p as never, NOW);
    const { where, orderBy, take } = p.activityRow.findMany.mock.calls[0][0];
    // Bounded above by the head read BEFORE the scan.
    expect(where.id).toEqual({ gt: 41n, lte: 90n });
    expect(where.kind).toEqual({ in: ["network", "auth"] });
    expect(where.severity).toEqual({ in: ["warn", "err"] });
    expect(where.at.gte.getTime()).toBe(NOW.getTime() - SECURITY_EVENT_RETENTION_DAYS * 86_400_000);
    expect(orderBy).toEqual({ id: "asc" });
    expect(take).toBe(500);
  });

  it("the severity filter uses the DATABASE value `err` — not `error`", async () => {
    // list_threat_events filters on "error", which ActivitySeverity does not
    // contain, so it never returns an err row. The mirror must not repeat it.
    const p = mirrorPrisma([]);
    await mirrorThreatRows(p as never, NOW);
    expect(p.activityRow.findMany.mock.calls[0][0].where.severity.in).toContain("err");
    expect(p.activityRow.findMany.mock.calls[0][0].where.severity.in).not.toContain("error");
  });

  it("advances the cursor to the last row read and stamps the run", async () => {
    const p = mirrorPrisma([
      { id: 42n, kind: "auth", severity: "warn" },
      { id: 57n, kind: "network", severity: "err" },
    ]);
    const r = await mirrorThreatRows(p as never, NOW);
    expect(r).toEqual({ scanned: 2, mirrored: 2, cursor: 57n });
    expect(p.securityIngestState.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { threatCursor: 57n, threatMirrorRanAt: NOW },
    });
    const { data, skipDuplicates } = p.securityEvent.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data.map((d: SecurityEventDraft) => [d.dedupeKey, d.severity])).toEqual([
      ["activity:42", "notice"],
      ["activity:57", "alert"],
    ]);
  });

  it("caught up: the cursor jumps to the chain head, so a quiet box stops rescanning 30 days every minute", async () => {
    // One threat among thousands of ordinary rows: without this the cursor
    // stayed at 42 and every tick rescanned everything after it.
    const p = mirrorPrisma([{ id: 42n, kind: "auth", severity: "warn" }], 0n, 5_000n);
    const r = await mirrorThreatRows(p as never, NOW);
    expect(r.cursor).toBe(5_000n);
  });

  it("a FULL batch stops at its last row, not the head — there may be more matches behind it", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: BigInt(10 + i), kind: "auth", severity: "warn" }));
    const p = mirrorPrisma(rows, 0n, 5_000n);
    const r = await mirrorThreatRows(p as never, NOW, 3);
    expect(r.cursor).toBe(12n);
  });

  it("an empty chain never moves the cursor backwards", async () => {
    const p = mirrorPrisma([], 99n, null);
    p.activityRow.aggregate.mockResolvedValue({ _max: { id: null } });
    const r = await mirrorThreatRows(p as never, NOW);
    expect(r.cursor).toBe(99n);
  });

  it("nothing new: no write, cursor unchanged, but the run is still stamped (health reads it)", async () => {
    const p = mirrorPrisma([], 99n);
    const r = await mirrorThreatRows(p as never, NOW);
    expect(r.cursor).toBe(99n);
    expect(p.securityEvent.createMany).not.toHaveBeenCalled();
    expect(p.securityIngestState.update.mock.calls[0][0].data).toEqual({ threatCursor: 99n, threatMirrorRanAt: NOW });
  });
});

describe("trimSecurityEvents — 30 days by default", () => {
  it("deletes rows that STARTED before the horizon and records the run", async () => {
    const p = {
      securityEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 12 }) },
      securityIngestState: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const r = await trimSecurityEvents(p as never, undefined, NOW);
    const before = new Date(NOW.getTime() - 30 * 86_400_000);
    expect(r).toEqual({ deleted: 12, before });
    expect(p.securityEvent.deleteMany).toHaveBeenCalledWith({ where: { startedAt: { lt: before } } });
    expect(p.securityIngestState.upsert.mock.calls[0][0].update).toEqual({ retentionRanAt: NOW, retentionDeleted: 12 });
  });
});

describe("WARP-2978 — the retention leg trims incidents with the events' own horizon (§6.10)", () => {
  it("calls trimSecurityIncidents with trimSecurityEvents' `before`, and records how many incidents went", async () => {
    const scheduleCron = vi.fn();
    const p = {
      securityEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
      securityIngestState: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    };
    incidentTrim.mockResolvedValueOnce({ marked: 2, deleted: 3 });
    registerSecurityJobs({ scheduleInterval: vi.fn(), scheduleCron }, p as never);
    const leg = scheduleCron.mock.calls[0][1] as () => Promise<void>;
    await leg();
    const before = (p.securityEvent.deleteMany.mock.calls[0][0] as { where: { startedAt: { lt: Date } } }).where.startedAt.lt;
    expect(incidentTrim).toHaveBeenCalledWith(p, before, expect.any(Date));
    expect(p.securityIngestState.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { retentionIncidentsDeleted: 3 },
    });
  });
});

describe("registerSecurityJobs — on the cron runtime, single-flighted", () => {
  it("schedules the mirror every minute and retention nightly, each under its own advisory lock", () => {
    // A bare setInterval / while(true) in place of the runtime fails this.
    const scheduleInterval = vi.fn();
    const scheduleCron = vi.fn();
    registerSecurityJobs({ scheduleInterval, scheduleCron }, {} as never);
    expect(scheduleInterval).toHaveBeenCalledWith(SECURITY_THREAT_MIRROR_INTERVAL_MS, expect.any(Function), {
      lockKey: SECURITY_THREAT_MIRROR_LOCK_KEY,
    });
    expect(scheduleCron).toHaveBeenCalledWith(SECURITY_RETENTION_CRON, expect.any(Function), {
      lockKey: SECURITY_RETENTION_LOCK_KEY,
    });
    expect(SECURITY_THREAT_MIRROR_LOCK_KEY).not.toBe(SECURITY_RETENTION_LOCK_KEY);
    expect(securityIngestHealthState().jobsRegistered).toBe(true);
  });
});

describe("noteFrigateSubscription — a refused topic is loud", () => {
  const all = ["frigate/events", "frigate/+/status/detect", "frigate/available"];

  it("all three granted → subscribed", () => {
    noteFrigateSubscription(all.map((topic) => ({ topic, qos: 1 })), NOW);
    expect(securityIngestHealthState()).toMatchObject({ frigateSubscribed: true, frigateSubscribedAt: NOW });
  });

  it("a missing grant is a refusal too", () => {
    noteFrigateSubscription([{ topic: "frigate/events", qos: 1 }], NOW);
    expect(securityIngestHealthState().frigateSubscribed).toBe(false);
    expect(securityIngestHealthState().frigateSubscribeError).toContain("frigate/available");
  });
});

describe("buildSecurityHealth — 'nothing reporting' never reads as 'all clear'", () => {
  const base = {
    frigateConfigured: true,
    frigate: { health: "online" as const, at: NOW },
    state: { threatMirrorRanAt: NOW, retentionRanAt: NOW, retentionDeleted: 3 },
    now: NOW,
  };
  const ingest = (over: Partial<ReturnType<typeof securityIngestHealthState>> = {}) => ({
    ...securityIngestHealthState(),
    frigateSubscribed: true,
    frigateSubscribedAt: NOW,
    lastFrigateMessageAt: NOW,
    jobsRegistered: true,
    ...over,
  });
  const row = (rows: ReturnType<typeof buildSecurityHealth>, id: string) => rows.find((r) => r.id === id)!;

  it("everything healthy → ok across the board", () => {
    const rows = buildSecurityHealth({ ...base, ingest: ingest() });
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["camera_ingest", "ok"],
      ["camera_system", "ok"],
      ["threat_mirror", "ok"],
      ["retention", "ok"],
    ]);
  });

  it("not subscribed → the camera ingest is DOWN, with the broker's reason", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({ frigateSubscribed: false, frigateSubscribeError: "broker refused frigate/events" }),
    });
    expect(row(rows, "camera_ingest")).toMatchObject({ state: "down", detail: "broker refused frigate/events" });
  });

  it("subscribed but silent for more than 6 hours → quiet, not ok", () => {
    const old = new Date(NOW.getTime() - 7 * 3_600_000);
    const rows = buildSecurityHealth({ ...base, ingest: ingest({ lastFrigateMessageAt: old, frigateSubscribedAt: old }) });
    expect(row(rows, "camera_ingest").state).toBe("quiet");
  });

  it("the latest write failed and nothing saved since → down", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({
        lastRecordedAt: new Map([["frigate", new Date(NOW.getTime() - 60_000)]]),
        lastWriteError: new Map([["frigate", { at: NOW, message: "x" }]]),
      }),
    });
    expect(row(rows, "camera_ingest").state).toBe("down");
  });

  it("a write failure followed by a successful write → ok again", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({
        lastWriteError: new Map([["frigate", { at: new Date(NOW.getTime() - 60_000), message: "x" }]]),
        lastRecordedAt: new Map([["frigate", NOW]]),
      }),
    });
    expect(row(rows, "camera_ingest").state).toBe("ok");
  });

  it("WARP-2977 P2b-2 (review F1): a camera STATUS row the tracker could not save is a camera write too → down", () => {
    const rows = buildSecurityHealth({ ...base, ingest: ingest({ statusUnsaved: new Set(["1\u0000cam1"]) }) });
    expect(row(rows, "camera_ingest").state).toBe("down");
  });

  it("WARP-2977 P2b-2 (review F1): an old status write error with nothing left unsaved is NOT down", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({ lastWriteError: new Map([["frigate_status", { at: NOW, message: "x" }]]) }),
    });
    expect(row(rows, "camera_ingest").state).toBe("ok");
  });

  it("WARP-2977 P2b-2: a failed write of a source that is not a camera's (a lock, a mode change) leaves camera_ingest alone", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({ lastWriteError: new Map([["matter_lock", { at: NOW, message: "x" }]]) }),
    });
    expect(row(rows, "camera_ingest").state).toBe("ok");
  });

  it("Frigate offline → the camera system row is down; never heard from → quiet", () => {
    expect(row(buildSecurityHealth({ ...base, ingest: ingest(), frigate: { health: "offline", at: NOW } }), "camera_system").state).toBe("down");
    expect(row(buildSecurityHealth({ ...base, ingest: ingest(), frigate: undefined }), "camera_system").state).toBe("quiet");
  });

  it("no camera system configured → one not_configured row and no camera_system row", () => {
    const rows = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest() });
    expect(row(rows, "camera_ingest").state).toBe("not_configured");
    expect(rows.find((r) => r.id === "camera_system")).toBeUndefined();
  });

  it("jobs never registered → mirror and retention are DOWN, not quiet", () => {
    const rows = buildSecurityHealth({ ...base, ingest: ingest({ jobsRegistered: false }) });
    expect(row(rows, "threat_mirror").state).toBe("down");
    expect(row(rows, "retention").state).toBe("down");
  });

  it("a mirror that has not run for 5 minutes, or retention not for 36 hours, reads quiet", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest(),
      state: {
        threatMirrorRanAt: new Date(NOW.getTime() - 6 * 60_000),
        retentionRanAt: new Date(NOW.getTime() - 37 * 3_600_000),
        retentionDeleted: 0,
      },
    });
    expect(row(rows, "threat_mirror").state).toBe("quiet");
    expect(row(rows, "retention").state).toBe("quiet");
  });

  it("WARP-2978: the retention row names events AND incidents (§6.10)", () => {
    const ran = buildSecurityHealth({
      ...base,
      ingest: ingest(),
      state: { threatMirrorRanAt: NOW, retentionRanAt: NOW, retentionDeleted: 3, retentionIncidentsDeleted: 1 },
    });
    expect(row(ran, "retention").detail).toBe("Keeps events 30 days and incidents a year; last removed 3 events and 1 incident");
    const one = buildSecurityHealth({
      ...base,
      ingest: ingest(),
      state: { threatMirrorRanAt: NOW, retentionRanAt: NOW, retentionDeleted: 1, retentionIncidentsDeleted: 0 },
    });
    expect(row(one, "retention").detail).toBe("Keeps events 30 days and incidents a year; last removed 1 event and 0 incidents");
    const never = buildSecurityHealth({ ...base, ingest: ingest(), state: null });
    expect(row(never, "retention").detail).toBe("Keeps events 30 days and incidents a year; not run yet");
  });

  it("WARP-2977 P2b: a site_mode row is placed after threat_mirror and before retention, verbatim", () => {
    const siteMode = { id: "site_mode" as const, state: "down" as const, detail: "Not running", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "camera_system", "threat_mirror", "site_mode", "retention"]);
    expect(row(rows, "site_mode")).toBe(siteMode);
  });

  it("WARP-2980: a patterns row lands after site_mode and before retention, verbatim", () => {
    const siteMode = { id: "site_mode" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const patterns = { id: "patterns" as const, state: "down" as const, detail: "Not running", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode, patterns });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "camera_system", "threat_mirror", "site_mode", "patterns", "retention"]);
    expect(row(rows, "patterns")).toBe(patterns);
  });

  it("WARP-2980: without a site_mode row, patterns still sits right before retention", () => {
    const patterns = { id: "patterns" as const, state: "quiet" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), patterns });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "threat_mirror", "patterns", "retention"]);
  });

  it("WARP-2977 P2b: the pinned order holds when rows drop out — no camera system, site_mode still before retention", () => {
    const siteMode = { id: "site_mode" as const, state: "not_configured" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), siteMode });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "threat_mirror", "site_mode", "retention"]);
  });

  it("WARP-2977 P2b-2: a locks row is placed after camera_system and before threat_mirror, verbatim — the full pinned order", () => {
    const siteMode = { id: "site_mode" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const locks = { id: "locks" as const, state: "not_configured" as const, detail: "No door locks paired", lastSeenAt: null };
    const incidents = { id: "incidents" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const alerts = { id: "alerts" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const patterns = { id: "patterns" as const, state: "quiet" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode, locks, incidents, alerts, patterns });
    // Every row the ADR-059 PRs add (WARP-2977 P2b-2 locks, WARP-2978 incidents
    // and alerts, WARP-2980 patterns), in the one pinned order.
    expect(rows.map((r) => r.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "locks",
      "threat_mirror",
      "site_mode",
      "incidents",
      "alerts",
      "patterns",
      "retention",
    ]);
    expect(row(rows, "locks")).toBe(locks);
  });

  it("WARP-2977 P2b-2: with no camera system the locks row still follows camera_ingest; omitted, the header is PR-1's", () => {
    const locks = { id: "locks" as const, state: "ok" as const, detail: "Listening to 1 lock", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), locks });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "locks", "threat_mirror", "retention"]);
    expect(buildSecurityHealth({ ...base, ingest: ingest() }).map((r) => r.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "retention",
    ]);
  });

  // WARP-2978 (ADR-059 P3 §6.11) — the pinned order grows:
  // camera_ingest, camera_system, (locks), threat_mirror, site_mode, incidents, alerts, retention.
  it("WARP-2978: incidents and alerts sit after site_mode and before retention, verbatim", () => {
    const siteMode = { id: "site_mode" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const incidents = { id: "incidents" as const, state: "down" as const, detail: "Not running", lastSeenAt: null };
    const alerts = { id: "alerts" as const, state: "ok" as const, detail: "Alerts go to Stefan", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode, incidents, alerts });
    expect(rows.map((r) => r.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "site_mode",
      "incidents",
      "alerts",
      "retention",
    ]);
    expect(row(rows, "incidents")).toBe(incidents);
    expect(row(rows, "alerts")).toBe(alerts);
  });

  it("WARP-2978: each of the two rows is placed on its own (alerts is owner/admin only and may be absent)", () => {
    const incidents = { id: "incidents" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), incidents });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "threat_mirror", "incidents", "retention"]);
  });

  // P3 merged after P5 PR-A, so P3 moves the pin (security-events.service.ts's header).
  it("WARP-2978 × WARP-2980: all three together — incidents, alerts, then patterns, then retention", () => {
    const siteMode = { id: "site_mode" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const incidents = { id: "incidents" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const alerts = { id: "alerts" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const patterns = { id: "patterns" as const, state: "quiet" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode, incidents, alerts, patterns });
    expect(rows.map((r) => r.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "site_mode",
      "incidents",
      "alerts",
      "patterns",
      "retention",
    ]);
  });
});

describe("listSecurityEvents — extraWhere narrows after the camera clause (WARP-2977 P2b)", () => {
  const findMany = vi.fn();
  const prisma = { securityEvent: { findMany } } as never;
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it("visibility stays AND[0]; the extra clauses follow the camera clause; the cursor stays last", async () => {
    const visibility = feedVisibilityWhere(new Set(["front"]), false, false);
    const zone = { camera: "front", OR: [{ kind: { in: ["camera_offline" as const, "camera_online" as const] } }] };
    const cursor = { startedAt: NOW, id: 9n };
    await listSecurityEvents(prisma, visibility, { limit: 10, includeLow: false, camera: "front", cursor }, [zone]);
    const and = findMany.mock.calls[0]![0].where.AND;
    expect(and[0]).toBe(visibility);
    expect(and[3]).toEqual({ camera: "front" });
    expect(and[4]).toBe(zone);
    expect(and[5]).toEqual({ OR: [{ startedAt: { lt: NOW } }, { startedAt: NOW, id: { lt: 9n } }] });
    expect(and).toHaveLength(6);
  });

  it("without extraWhere the query is exactly P2a's", async () => {
    await listSecurityEvents(prisma, {}, { limit: 10, includeLow: true });
    expect(findMany.mock.calls[0]![0].where.AND).toEqual([{}, {}, {}, {}, {}]);
  });

  it("WARP-2977 P2b-2: each row says how it was observed (a polled lock row is never timing evidence)", async () => {
    const at = new Date(NOW.getTime() - 1000);
    findMany.mockResolvedValue([
      {
        id: 5n,
        source: "matter_lock",
        kind: "lock_state",
        severity: "info",
        camera: null,
        sourceRef: "matter:7/1",
        labels: ["unlocked"],
        cameraZones: [],
        score: null,
        startedAt: at,
        endedAt: null,
        summary: "Back door lock: unlocked (found when Droplet checked)",
        observed: "polled",
      },
    ]);
    const page = await listSecurityEvents(prisma, {}, { limit: 10, includeLow: true });
    expect(page.events[0]).toMatchObject({ id: "5", kind: "lock_state", observed: "polled", frigateEventId: null });
  });
});

describe("feedVisibilityWhere — DS-005, the threat gate and the lock gate", () => {
  it("owner/admin with every camera and Devices view: no constraint", () => {
    expect(feedVisibilityWhere("all", true, true)).toEqual({});
  });

  it("granted cameras: rows from those cameras or from no camera", () => {
    expect(feedVisibilityWhere(new Set(["front"]), true, true)).toEqual({
      AND: [{ OR: [{ camera: null }, { camera: { in: ["front"] } }] }],
    });
  });

  it("no grants at all: only camera-less rows", () => {
    expect(feedVisibilityWhere(new Set(), true, true)).toEqual({ AND: [{ OR: [{ camera: null }, { camera: { in: [] } }] }] });
  });

  it("not owner/admin: mirrored threats are removed", () => {
    expect(feedVisibilityWhere("all", false, true)).toEqual({ AND: [{ source: { not: "activity_mirror" } }] });
  });

  it("WARP-2977 P2b-2 (DS-019): without Devices view, lock rows are removed — inside the same clause, after the others", () => {
    expect(feedVisibilityWhere("all", true, false)).toEqual({ AND: [{ source: { not: "matter_lock" } }] });
    expect(feedVisibilityWhere(new Set(["front"]), false, false)).toEqual({
      AND: [
        { OR: [{ camera: null }, { camera: { in: ["front"] } }] },
        { source: { not: "activity_mirror" } },
        { source: { not: "matter_lock" } },
      ],
    });
  });
});

describe("parseFeedCursor", () => {
  it("round-trips `<ms>.<id>`", () => {
    expect(parseFeedCursor("1790000000000.42")).toEqual({ startedAt: new Date(1_790_000_000_000), id: 42n });
  });
  it("rejects an id beyond Postgres BIGINT, so it is a 400 and not a 503", () => {
    expect(parseFeedCursor("1790000000000.9223372036854775807")?.id).toBe(9_223_372_036_854_775_807n);
    expect(parseFeedCursor("1790000000000.9223372036854775808")).toBeNull();
    expect(parseFeedCursor("1790000000000.9999999999999999999")).toBeNull();
  });

  it.each(["", "abc", "1.2.3", "-1.2", "1790000000000", "1e3.4"])("rejects %j", (raw) => {
    expect(parseFeedCursor(raw)).toBeNull();
  });
});
