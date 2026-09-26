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
// WARP-2979 — and to the link-evidence trim (Droplet's samples are presence data).
const linkTrim = vi.hoisted(() => vi.fn(async (_prisma: unknown, _before: Date) => ({ trimmed: 0 })));
vi.mock("./security-zones.service.js", () => ({ trimLinkEvidence: linkTrim }));

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

  it("WARP-2979: then trims Droplet's link-evidence samples with that SAME `before`, after the incidents", async () => {
    linkTrim.mockClear(); // the leg above ran it too
    const scheduleCron = vi.fn();
    const p = {
      securityEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      securityIngestState: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    };
    const order: string[] = [];
    incidentTrim.mockImplementationOnce(async () => {
      order.push("incidents");
      return { marked: 0, deleted: 0 };
    });
    linkTrim.mockImplementationOnce(async () => {
      order.push("links");
      return { trimmed: 2 };
    });
    registerSecurityJobs({ scheduleInterval: vi.fn(), scheduleCron }, p as never);
    await (scheduleCron.mock.calls[0][1] as () => Promise<void>)();
    const before = (p.securityEvent.deleteMany.mock.calls[0][0] as { where: { startedAt: { lt: Date } } }).where.startedAt.lt;
    expect(linkTrim).toHaveBeenCalledTimes(1);
    expect(linkTrim).toHaveBeenCalledWith(p, before);
    expect(order).toEqual(["incidents", "links"]);
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

  // WARP-2979 (P4 §6.15) — the pin grows: … alerts, links, (summaries — PR-2), patterns, retention.
  it("WARP-2979: the links row sits right after alerts and before patterns, verbatim — and on its own", () => {
    const siteMode = { id: "site_mode" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const incidents = { id: "incidents" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const alerts = { id: "alerts" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const links = { id: "links" as const, state: "down" as const, detail: "Not running", lastSeenAt: null };
    const patterns = { id: "patterns" as const, state: "quiet" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), siteMode, incidents, alerts, links, patterns });
    expect(rows.map((r) => r.id)).toEqual([
      "camera_ingest",
      "camera_system",
      "threat_mirror",
      "site_mode",
      "incidents",
      "alerts",
      "links",
      "patterns",
      "retention",
    ]);
    expect(row(rows, "links")).toBe(links);
    // A family viewer has no alerts row: links still follows incidents.
    const family = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), incidents, links });
    expect(family.map((r) => r.id)).toEqual(["camera_ingest", "threat_mirror", "incidents", "links", "retention"]);
  });

  // WARP-2979 PR-2 (P4 §6.15) — the summaries row sits right after links, before patterns.
  it("WARP-2979 PR-2: the summaries row sits right after links and before patterns, verbatim — and on its own", () => {
    const incidents = { id: "incidents" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const alerts = { id: "alerts" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const links = { id: "links" as const, state: "ok" as const, detail: "x", lastSeenAt: null };
    const summaries = { id: "summaries" as const, state: "down" as const, detail: "Not running", lastSeenAt: null };
    const patterns = { id: "patterns" as const, state: "quiet" as const, detail: "x", lastSeenAt: null };
    const rows = buildSecurityHealth({ ...base, ingest: ingest(), incidents, alerts, links, summaries, patterns });
    expect(rows.map((r) => r.id)).toEqual(["camera_ingest", "camera_system", "threat_mirror", "incidents", "alerts", "links", "summaries", "patterns", "retention"]);
    expect(row(rows, "summaries")).toBe(summaries);
    const alone = buildSecurityHealth({ ...base, frigateConfigured: false, ingest: ingest(), summaries });
    expect(alone.map((r) => r.id)).toEqual(["camera_ingest", "threat_mirror", "summaries", "retention"]);
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
    const visibility = feedVisibilityWhere(new Set(["front"]), false);
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
  it("rejects an id beyond Postgres BIGINT, so it is a 400 and not a 503", () => {
    expect(parseFeedCursor("1790000000000.9223372036854775807")?.id).toBe(9_223_372_036_854_775_807n);
    expect(parseFeedCursor("1790000000000.9223372036854775808")).toBeNull();
    expect(parseFeedCursor("1790000000000.9999999999999999999")).toBeNull();
  });

  it.each(["", "abc", "1.2.3", "-1.2", "1790000000000", "1e3.4"])("rejects %j", (raw) => {
    expect(parseFeedCursor(raw)).toBeNull();
  });
});
