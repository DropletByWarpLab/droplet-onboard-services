/**
 * WARP-2977 (ADR-059 §3.3, §6, §7) — the Security event store, mocked lane.
 *
 * What a mocked Prisma can prove: which statements run, with what `where`,
 * in what order. What it cannot — that `skipDuplicates` really absorbs a
 * redelivery, and that the visibility `where` really hides a camera — is
 * proven against Postgres in security-events.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSecurityHealth,
  createStatusTracker,
  feedVisibilityWhere,
  mirrorThreatRows,
  noteFrigateSubscription,
  parseFeedCursor,
  recordSecurityEvent,
  registerSecurityJobs,
  securityIngestHealthState,
  trimSecurityEvents,
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
    ...over,
  };
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

  it("never throws — a failed write is recorded for the health header", async () => {
    const prisma = { securityEvent: { createMany: vi.fn().mockRejectedValue(new Error("pool exhausted")) } } as never;
    await expect(recordSecurityEvent(prisma, draft())).resolves.toBe(false);
    expect(securityIngestHealthState().lastWriteError?.message).toBe("pool exhausted");
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
    expect(await t.observe("frigate/cam1/status/detect", "offline", NOW)).toBeNull();
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
    expect(r?.draft.kind).toBe("camera_offline");
    expect(r?.stored).toBe(true);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("a failed store write still reports the transition — the live surface must not depend on the database", async () => {
    const { t, createMany } = tracker("camera_online");
    createMany.mockRejectedValueOnce(new Error("db down"));
    const r = await t.observe("frigate/cam1/status/detect", "offline", NOW);
    expect(r).toMatchObject({ draft: { kind: "camera_offline", camera: "cam1" }, stored: false });
    // …and it is not reported twice when the same state repeats.
    expect(await t.observe("frigate/cam1/status/detect", "offline", NOW)).toBeNull();
  });

  it("the snapshot carries the latest reading, including Frigate's own (null key)", async () => {
    const { t } = tracker(null);
    await t.observe("frigate/available", "online", NOW);
    expect(t.snapshot().get(null)).toEqual({ health: "online", at: NOW });
  });

  it("a topic that is not a status topic does nothing", async () => {
    const { t, findFirst } = tracker(null);
    expect(await t.observe("frigate/cam1/status/record", "offline", NOW)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("mirrorThreatRows — the cursor, the filter, the horizon", () => {
  function mirrorPrisma(rows: Array<{ id: bigint; kind: string; severity: string }>, cursor = 0n) {
    return {
      securityIngestState: {
        upsert: vi.fn().mockResolvedValue({ threatCursor: cursor }),
        update: vi.fn().mockResolvedValue({}),
      },
      activityRow: {
        findMany: vi.fn().mockResolvedValue(rows.map((r) => ({ ...r, at: NOW, what: `row ${r.id}` }))),
      },
      securityEvent: { createMany: vi.fn().mockResolvedValue({ count: rows.length }) },
    };
  }

  it("reads only warn/err network/auth rows after the cursor and inside the retention horizon", async () => {
    const p = mirrorPrisma([], 41n);
    await mirrorThreatRows(p as never, NOW);
    const { where, orderBy, take } = p.activityRow.findMany.mock.calls[0][0];
    expect(where.id).toEqual({ gt: 41n });
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
      ingest: ingest({ lastRecordedAt: new Date(NOW.getTime() - 60_000), lastWriteError: { at: NOW, message: "x" } }),
    });
    expect(row(rows, "camera_ingest").state).toBe("down");
  });

  it("a write failure followed by a successful write → ok again", () => {
    const rows = buildSecurityHealth({
      ...base,
      ingest: ingest({ lastWriteError: { at: new Date(NOW.getTime() - 60_000), message: "x" }, lastRecordedAt: NOW }),
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
});

describe("feedVisibilityWhere — DS-005 and the threat gate", () => {
  it("owner/admin with every camera: no constraint", () => {
    expect(feedVisibilityWhere("all", true)).toEqual({});
  });

  it("granted cameras: rows from those cameras or from no camera", () => {
    expect(feedVisibilityWhere(new Set(["front"]), true)).toEqual({
      AND: [{ OR: [{ camera: null }, { camera: { in: ["front"] } }] }],
    });
  });

  it("no grants at all: only camera-less rows", () => {
    expect(feedVisibilityWhere(new Set(), true)).toEqual({ AND: [{ OR: [{ camera: null }, { camera: { in: [] } }] }] });
  });

  it("not owner/admin: mirrored threats are removed", () => {
    expect(feedVisibilityWhere("all", false)).toEqual({ AND: [{ source: { not: "activity_mirror" } }] });
  });
});

describe("parseFeedCursor", () => {
  it("round-trips `<ms>.<id>`", () => {
    expect(parseFeedCursor("1790000000000.42")).toEqual({ startedAt: new Date(1_790_000_000_000), id: 42n });
  });
  it.each(["", "abc", "1.2.3", "-1.2", "1790000000000", "1e3.4"])("rejects %j", (raw) => {
    expect(parseFeedCursor(raw)).toBeNull();
  });
});
