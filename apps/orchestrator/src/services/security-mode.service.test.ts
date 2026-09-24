/**
 * WARP-2977 P2b — services/security-mode.service.ts on the mocked lane (an
 * in-memory fake with CAS and rollback: src/__tests__/security-site.fake.ts).
 *
 * The audit goes through the REAL security-audit.ts helpers; only the chain
 * itself is mocked (`recordActivityInTx` for people, the cron recorder for
 * the system), so every assertion about kind / severity / refs is about the
 * row that would actually be signed.
 *
 * Pinned (spec §9): a schedule flip is one CAS + one mode_changed row stamped
 * at the boundary and NO ActivityRow, and a second tick writes nothing; an
 * expiry is a row stamped at manualUntil + a system audit through the
 * throwing recorder, whose failure does not undo the expiry; a source-only
 * change writes no row; a lost CAS skips the tick; unreadable hours write
 * nothing and turn the health row down; the health row's states including
 * the 3-minute grace; every hours write bumps the mode version.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const h = vi.hoisted(() => ({
  inTx: vi.fn(),
  record: vi.fn(),
  recorderOn: true,
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivityInTx: (...args: unknown[]) => h.inTx(...args),
  getActivityRecorder: () => (h.recorderOn ? { record: h.record } : null),
  recordActivity: vi.fn(),
}));

import {
  SECURITY_SITE_MODE_GRACE_MS,
  SECURITY_SITE_MODE_INTERVAL_MS,
  SECURITY_SITE_MODE_LOCK_KEY,
  _resetSiteModeHealthForTests,
  actOnMode,
  applyModeChange,
  deleteHoursException,
  readHoursView,
  readModeView,
  registerSecurityModeJobs,
  securitySiteModeHealth,
  siteModeHealthRow,
  siteModeHealthState,
  summaryName,
  tickSecurityMode,
  writeHoursException,
  writeSiteHours,
  type SiteModeHealthState,
} from "./security-mode.service.js";
import { SecurityAuditUnavailableError } from "./security-audit.js";
import { zonedWallClockToUtc } from "../lib/zoned-time.js";
import {
  defaultHours,
  defaultMode,
  fakePrisma,
  newWorld,
  weekRows,
  type FakeWorld,
} from "../__tests__/security-site.fake.js";

const TZ = "Europe/London";
const WEEKDAYS = weekRows(["09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "closed", "closed"]);
const MARIA = "22222222-2222-4222-8222-222222222222";
const WHO = { req: { user: { id: MARIA, role: "family" } }, id: MARIA, name: "Maria" };
const REQ_FOR_FROM = WHO.req;

function at(ymd: string, time: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [hh, mi, s = 0] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, hh!, mi!, s, TZ);
}

/** A world with weekday 09–17 hours in London and the given stored mode. */
function world(mode: Partial<ReturnType<typeof defaultMode>> = {}, over: Partial<FakeWorld> = {}): FakeWorld {
  return newWorld({
    hours: defaultHours({ state: "set", timezone: TZ, version: 3 }),
    mode: defaultMode(mode),
    days: WEEKDAYS.map((d) => ({ ...d })),
    ...over,
  });
}

function db(w: FakeWorld) {
  const p = fakePrisma(w);
  return { p, prisma: p as unknown as PrismaClient };
}

beforeEach(() => {
  _resetSiteModeHealthForTests();
  h.inTx.mockReset().mockImplementation(async () => {
    return { id: 1n };
  });
  h.record.mockReset().mockResolvedValue({ id: 2n });
  h.recorderOn = true;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── the ticker ────────────────────────────────────────────────────────────

describe("registerSecurityModeJobs", () => {
  it("registers ONE 60 s interval single-flighted on its lockKey, and marks the ticker registered", () => {
    const scheduleInterval = vi.fn();
    const w = world();
    expect(siteModeHealthState().registeredAt).toBeNull();
    registerSecurityModeJobs({ scheduleInterval }, db(w).prisma);
    expect(scheduleInterval).toHaveBeenCalledTimes(1);
    expect(scheduleInterval).toHaveBeenCalledWith(SECURITY_SITE_MODE_INTERVAL_MS, expect.any(Function), {
      lockKey: SECURITY_SITE_MODE_LOCK_KEY,
    });
    expect(SECURITY_SITE_MODE_INTERVAL_MS).toBe(60_000);
    expect(SECURITY_SITE_MODE_LOCK_KEY).toBe("droplet:security-site-mode");
    expect(siteModeHealthState().registeredAt).toBeInstanceOf(Date);
  });

  it("the registered handler IS the tick (it reconciles the stored mode)", async () => {
    const scheduleInterval = vi.fn();
    // Stored open, but no hours and a manual Away: nothing to do → still a real tick that records lastOkAt.
    const w = world({ mode: "away", modeSource: "manual", manualEnd: "until_changed" });
    registerSecurityModeJobs({ scheduleInterval }, db(w).prisma);
    const handler = scheduleInterval.mock.calls[0]![1] as () => Promise<void>;
    await handler();
    expect(siteModeHealthState().lastOkAt).toBeInstanceOf(Date);
  });
});

describe("tickSecurityMode", () => {
  it("a schedule flip: one CAS + one mode_changed row stamped at the boundary, NO ActivityRow; a second tick writes nothing", async () => {
    const w = world({ setAt: at("2026-09-23", "08:00") });
    const { p, prisma } = db(w);
    const now = at("2026-09-23", "17:00:40");
    // 08:00 → the 09:00 opening was never seen as a flip because stored says open; at 17:00:40 it is closed.
    expect(await tickSecurityMode(prisma, now)).toEqual({ outcome: "changed" });
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "schedule", manualEnd: "none", version: 1, setById: null });
    expect(w.mode!.setAt).toEqual(at("2026-09-23", "17:00"));
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({
      source: "site_mode",
      kind: "mode_changed",
      severity: "info",
      camera: null,
      sourceRef: "site",
      dedupeKey: "site_mode:v1",
      labels: ["closed", "schedule", "open"],
      cameraZones: [],
      startedAt: at("2026-09-23", "17:00"),
      summary: "Closed (opening hours)",
    });
    expect(p.securityModeState.updateMany).toHaveBeenCalledTimes(1);
    expect(h.inTx).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(siteModeHealthState().lastOkAt).toEqual(now);

    expect(await tickSecurityMode(prisma, at("2026-09-23", "17:01:40"))).toEqual({ outcome: "unchanged" });
    expect(w.events).toHaveLength(1);
    expect(w.mode!.version).toBe(1);
    expect(p.securityModeState.updateMany).toHaveBeenCalledTimes(1);
  });

  it("after downtime, missed flips collapse into ONE row at the last boundary", async () => {
    // Stored closed since Tue 17:00; the box was down all Wednesday; now Wed 20:00 → still closed: nothing to write.
    const w = world({ mode: "closed", setAt: at("2026-09-22", "17:00") });
    const { prisma } = db(w);
    expect(await tickSecurityMode(prisma, at("2026-09-23", "20:00"))).toEqual({ outcome: "unchanged" });
    // Down until Thursday noon: closed → open, stamped at Thursday's 09:00, one row.
    expect(await tickSecurityMode(prisma, at("2026-09-24", "12:00"))).toEqual({ outcome: "changed" });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.startedAt).toEqual(at("2026-09-24", "09:00"));
  });

  it("an expiry: a row stamped at manualUntil, then the system audit through the THROWING recorder", async () => {
    const until = at("2026-09-24", "09:00");
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: until, setById: MARIA, version: 7 });
    const { prisma } = db(w);
    expect(await tickSecurityMode(prisma, at("2026-09-24", "09:00:30"))).toEqual({ outcome: "changed" });
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null, version: 8, setById: null });
    expect(w.events).toEqual([
      expect.objectContaining({ dedupeKey: "site_mode:v8", labels: ["open", "schedule", "closed"], startedAt: until, summary: "Open (opening hours)" }),
    ]);
    expect(h.inTx).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    const params = h.record.mock.calls[0]![0];
    expect(params).toMatchObject({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      what: "Security: opening hours took over from a manual Close up",
      actor: { type: "system", id: null },
      refs: {
        surface: "security",
        action: "mode.expire",
        endedMode: "closed",
        endedManualEnd: "next_opening",
        endedAt: until.toISOString(),
        setById: MARIA,
        mode: "open",
        version: 8,
      },
    });
  });

  it("a recorder failure does NOT roll the expiry back — the throw reaches safeRun", async () => {
    const until = at("2026-09-24", "09:00");
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: until });
    const { prisma } = db(w);
    h.record.mockRejectedValueOnce(new Error("chain down"));
    await expect(tickSecurityMode(prisma, at("2026-09-24", "09:00:30"))).rejects.toThrow("chain down");
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule" });
    expect(w.events).toHaveLength(1);
    expect(siteModeHealthState().lastOkAt).toEqual(at("2026-09-24", "09:00:30"));
  });

  it("an uninitialised recorder throws too (never a silent unaudited expiry)", async () => {
    h.recorderOn = false;
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00") });
    await expect(tickSecurityMode(db(w).prisma, at("2026-09-24", "09:01"))).rejects.toThrow(/not initialised/);
    expect(w.mode!.modeSource).toBe("schedule");
  });

  it("a source-only change (an Open up ending into open hours) writes no feed row, but audits the expiry", async () => {
    const w = world({ mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "12:30") });
    const { prisma } = db(w);
    expect(await tickSecurityMode(prisma, at("2026-09-23", "12:31"))).toEqual({ outcome: "changed" });
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", manualEnd: "none" });
    expect(w.events).toEqual([]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0].what).toBe("Security: opening hours took over from a manual Open up");
  });

  it("a lost CAS skips the tick: no row, no audit, not counted as a reconcile", async () => {
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00") });
    const { p, prisma } = db(w);
    p.securityModeState.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await tickSecurityMode(prisma, at("2026-09-24", "09:01"))).toEqual({ outcome: "conflict" });
    expect(w.events).toEqual([]);
    expect(h.record).not.toHaveBeenCalled();
    expect(siteModeHealthState().lastOkAt).toBeNull();
  });

  it.each([
    ["an unknown zone", { hours: defaultHours({ state: "set", timezone: "Mars/Base" }) }, /Mars\/Base/],
    ["6 weekday rows", { days: WEEKDAYS.slice(0, 6).map((d) => ({ ...d })) }, /one row per weekday/],
  ])("%s: no write, and the health row goes down with the reason", async (_l, over, reason) => {
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00") }, over);
    const { p, prisma } = db(w);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-24", "08:00"));
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, prisma);
    const now = at("2026-09-24", "09:30");
    expect(await tickSecurityMode(prisma, now)).toEqual({ outcome: "hours_unreadable" });
    expect(p.securityModeState.updateMany).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
    const row = siteModeHealthRow(siteModeHealthState(), { state: "set", timezone: TZ }, w.mode, now);
    expect(row.state).toBe("down");
    expect(row.detail).toMatch(/^Opening hours can't be read: /);
    expect(row.detail).toMatch(reason);
  });

  it("a database error is recorded for the health row and rethrown for safeRun", async () => {
    const w = world();
    const { p, prisma } = db(w);
    p.securitySiteHours.findUnique.mockRejectedValueOnce(new Error("connection refused"));
    await expect(tickSecurityMode(prisma, at("2026-09-23", "12:00"))).rejects.toThrow("connection refused");
    expect(siteModeHealthState().lastError?.message).toBe("the database couldn't be read");
  });

  it("creates the singletons lazily on a fresh box (no hours: open, nothing to write)", async () => {
    const w = newWorld();
    const { p, prisma } = db(w);
    expect(await tickSecurityMode(prisma, at("2026-09-23", "12:00"))).toEqual({ outcome: "unchanged" });
    expect(w.hours).toMatchObject({ state: "not_set", version: 0 });
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule" });
    // INSERT … ON CONFLICT DO NOTHING, never Prisma's read-then-insert upsert(update: {}) (P2002 on a race).
    expect(p.securityModeState.createMany).toHaveBeenCalledWith({ data: [{ id: "singleton" }], skipDuplicates: true });
    expect(p.securitySiteHours.createMany).toHaveBeenCalledWith({ data: [{ id: "singleton" }], skipDuplicates: true });
    expect(p.securityModeState.upsert).not.toHaveBeenCalled();
    expect(p.securitySiteHours.upsert).not.toHaveBeenCalled();
  });

  it("reads the mode row and the hours in ONE repeatable-read snapshot, mode row first", async () => {
    const w = world();
    const { p, prisma } = db(w);
    expect(await tickSecurityMode(prisma, at("2026-09-23", "12:00"))).toEqual({ outcome: "unchanged" });
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(p.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0]!;
    expect(order(p.securityModeState.findUnique)).toBeLessThan(order(p.securitySiteHours.findUnique));
    expect(order(p.securitySiteHours.findUnique)).toBeLessThan(order(p.securitySchedule.findMany));
  });
});

// ── health ────────────────────────────────────────────────────────────────

describe("siteModeHealthRow", () => {
  const NOW = at("2026-09-23", "12:00");
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const health = (over: Partial<SiteModeHealthState>): SiteModeHealthState => ({
    registeredAt: minutesAgo(60),
    lastOkAt: minutesAgo(1),
    lastError: null,
    ...over,
  });
  const set = { state: "set" as const, timezone: TZ };
  const sched = defaultMode();

  it("not registered → down 'Not running'", () => {
    expect(siteModeHealthRow(health({ registeredAt: null, lastOkAt: null }), set, sched, NOW)).toEqual({
      id: "site_mode",
      state: "down",
      detail: "Not running",
      lastSeenAt: null,
    });
  });

  it("an error newer than the last good tick → down with the reason; an older one is history", () => {
    expect(
      siteModeHealthRow(health({ lastError: { at: minutesAgo(0.5), message: "boom" } }), set, sched, NOW),
    ).toMatchObject({ state: "down", detail: "Opening hours can't be read: boom" });
    expect(siteModeHealthRow(health({ lastError: { at: minutesAgo(5), message: "boom" } }), set, sched, NOW).state).toBe("ok");
  });

  it("the 3-minute grace: a fresh registration with no tick yet is fine; past the grace it is down", () => {
    expect(SECURITY_SITE_MODE_GRACE_MS).toBe(180_000);
    expect(siteModeHealthRow(health({ registeredAt: minutesAgo(2), lastOkAt: null }), set, sched, NOW).state).toBe("ok");
    expect(siteModeHealthRow(health({ registeredAt: minutesAgo(4), lastOkAt: null }), set, sched, NOW)).toMatchObject({
      state: "down",
      detail: "Hasn't checked the opening hours since 11:56 AM",
    });
    expect(siteModeHealthRow(health({ lastOkAt: minutesAgo(2) }), set, sched, NOW).state).toBe("ok");
    expect(siteModeHealthRow(health({ lastOkAt: minutesAgo(4) }), set, sched, NOW)).toMatchObject({
      state: "down",
      detail: "Hasn't checked the opening hours since 11:56 AM",
      lastSeenAt: minutesAgo(4).toISOString(),
    });
    // No site zone: minutes, never a UTC clock.
    expect(siteModeHealthRow(health({ lastOkAt: minutesAgo(10) }), { state: "not_set" }, sched, NOW).detail).toBe(
      "Hasn't checked the opening hours for 10 minutes",
    );
  });

  it("unreadable hours or state → down", () => {
    expect(siteModeHealthRow(health({}), null, null, NOW)).toMatchObject({ state: "down", detail: "Opening hours can't be read" });
  });

  it("not set → not_configured, and says what that means", () => {
    expect(siteModeHealthRow(health({}), { state: "not_set" }, sched, NOW)).toEqual({
      id: "site_mode",
      state: "not_configured",
      detail: "No opening hours set, so the site counts as open all the time",
      lastSeenAt: minutesAgo(1).toISOString(),
    });
  });

  it("ok copy names what is in charge, in the site zone", () => {
    expect(siteModeHealthRow(health({}), set, sched, NOW).detail).toBe("Following opening hours (Europe/London)");
    const closedUp = defaultMode({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-29", "09:00") });
    expect(siteModeHealthRow(health({}), set, closedUp, NOW).detail).toBe("Closed up by hand until Tue 9:00 AM");
    const openUp = defaultMode({ mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "14:00") });
    expect(siteModeHealthRow(health({}), set, openUp, NOW).detail).toBe("Opened up by hand until 2:00 PM");
    expect(siteModeHealthRow(health({}), set, defaultMode({ mode: "away", modeSource: "manual", manualEnd: "until_changed" }), NOW).detail).toBe(
      "Set to away by hand",
    );
    expect(
      siteModeHealthRow(health({}), set, defaultMode({ mode: "closed", modeSource: "manual", manualEnd: "until_changed" }), NOW).detail,
    ).toBe("Closed up by hand until someone changes it");
    // An override whose end has passed reads as the hours again.
    const expired = defaultMode({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: minutesAgo(1) });
    expect(siteModeHealthRow(health({}), set, expired, NOW).detail).toBe("Following opening hours (Europe/London)");
  });
});

describe("securitySiteModeHealth", () => {
  it("reads without writing, and a failed read is a down row (never a throw)", async () => {
    const w = world();
    const { p, prisma } = db(w);
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, prisma);
    const row = await securitySiteModeHealth(prisma, new Date());
    expect(row.id).toBe("site_mode");
    expect(p.securitySiteHours.upsert).not.toHaveBeenCalled();
    expect(p.securityModeState.upsert).not.toHaveBeenCalled();
    p.securitySiteHours.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await securitySiteModeHealth(prisma, new Date())).toMatchObject({ state: "down", detail: "Opening hours can't be read" });
  });

  it("not registered → 'Not running' whatever the tables say", async () => {
    const w = world();
    expect(await securitySiteModeHealth(db(w).prisma, new Date())).toMatchObject({ state: "down", detail: "Not running" });
  });
});

// ── mode writes ───────────────────────────────────────────────────────────

describe("applyModeChange", () => {
  it("CAS → feed row → audit LAST, in one READ COMMITTED transaction", async () => {
    const w = world({ version: 4 });
    const { p, prisma } = db(w);
    h.inTx.mockImplementation(async () => {
      w.log.push("audit");
      return { id: 1n };
    });
    const r = await applyModeChange(prisma, {
      plan: { current: { ...w.mode! }, next: { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null } },
      actor: { type: "user", id: MARIA, name: "Maria" },
      startedAt: at("2026-09-23", "12:00"),
      summary: "Set to away by Maria",
      audit: { req: WHO.req, entry: { action: "mode.away", what: "Security: set to away" } },
    });
    expect(r).toMatchObject({ status: "applied", modeChangedRow: true, state: { version: 5, setById: MARIA } });
    expect(w.log).toEqual(["mode.cas", "event.create", "audit"]);
    expect(p.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted" });
  });

  it("a lost CAS writes nothing and audits nothing", async () => {
    const w = world({ version: 4 });
    const r = await applyModeChange(db(w).prisma, {
      plan: { current: { ...w.mode!, version: 3 }, next: { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null } },
      actor: { type: "user", id: MARIA, name: "Maria" },
      startedAt: at("2026-09-23", "12:00"),
      summary: "x",
      audit: { req: WHO.req, entry: { action: "mode.away", what: "Security: set to away" } },
    });
    expect(r).toEqual({ status: "conflict" });
    expect(h.inTx).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
    expect(w.mode!.version).toBe(4);
  });

  it("an audit failure rolls the change back and surfaces as SecurityAuditUnavailableError", async () => {
    const w = world({ version: 4 });
    h.inTx.mockRejectedValueOnce(new Error("chain lock timeout"));
    await expect(
      applyModeChange(db(w).prisma, {
        plan: { current: { ...w.mode! }, next: { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null } },
        actor: { type: "user", id: MARIA, name: "Maria" },
        startedAt: at("2026-09-23", "12:00"),
        summary: "x",
        audit: { req: WHO.req, entry: { action: "mode.away", what: "Security: set to away" } },
      }),
    ).rejects.toBeInstanceOf(SecurityAuditUnavailableError);
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", version: 4 });
    expect(w.events).toEqual([]);
  });
});

describe("actOnMode", () => {
  it("Close up in hours: closed until tomorrow's opening, a feed row naming the person, one audit row", async () => {
    const w = world();
    const now = at("2026-09-23", "12:00");
    const r = await actOnMode(db(w).prisma, WHO, { action: "close" }, now);
    expect(r).toMatchObject({
      status: "ok",
      changed: true,
      mode: { mode: "closed", source: "manual", manualEnd: "next_opening", until: at("2026-09-24", "09:00").toISOString(), setBy: { id: MARIA, name: "Maria" } },
    });
    expect(w.events).toEqual([expect.objectContaining({ summary: "Closed up by Maria", startedAt: now, labels: ["closed", "manual", "open"] })]);
    expect(h.inTx).toHaveBeenCalledTimes(1);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      what: "Security: closed up",
      actor: { type: "user", id: MARIA },
      refs: {
        surface: "security",
        action: "mode.close",
        from: "open",
        mode: "closed",
        source: "manual",
        manualEnd: "next_opening",
        until: at("2026-09-24", "09:00").toISOString(),
      },
    });
  });

  it("the same action again is changed:false — nothing written, nothing audited", async () => {
    const w = world();
    const { prisma } = db(w);
    await actOnMode(prisma, WHO, { action: "close" }, at("2026-09-23", "12:00"));
    h.inTx.mockClear();
    const r = await actOnMode(prisma, WHO, { action: "close" }, at("2026-09-23", "12:05"));
    expect(r).toMatchObject({ status: "ok", changed: false, mode: { mode: "closed" } });
    expect(h.inTx).not.toHaveBeenCalled();
    expect(w.events).toHaveLength(1);
  });

  // P3's mode history: every row carries the mode it changed FROM, so the rows alone answer "the mode at t" —
  // even once retention has removed the row that set it, and even before the first row.
  it("each mode_changed row carries its FROM mode, so the mode at t survives retention trimming the row that set it", async () => {
    const w = world();
    const { prisma } = db(w);
    await actOnMode(prisma, WHO, { action: "away" }, at("2026-08-24", "12:00")); // day −30: away
    await actOnMode(prisma, WHO, { action: "resume" }, at("2026-09-02", "12:00")); // day −21: back to the hours (open)
    expect(w.events.map((e) => e.labels)).toEqual([
      ["away", "manual", "open"],
      ["open", "schedule", "away"],
    ]);
    // The contract P3 reads by: the latest row at or before t, else the earliest row after t's FROM mode, else the current mode.
    const modeAt = (t: Date): string => {
      const rows = [...w.events].sort((a, b) => (a.startedAt as Date).getTime() - (b.startedAt as Date).getTime());
      const before = rows.filter((r) => (r.startedAt as Date).getTime() <= t.getTime()).at(-1);
      if (before) return (before.labels as string[])[0]!;
      const after = rows.find((r) => (r.startedAt as Date).getTime() > t.getTime());
      return after ? (after.labels as string[])[2]! : w.mode!.mode;
    };
    expect(modeAt(at("2026-08-20", "12:00"))).toBe("open"); // before the first row
    expect(modeAt(at("2026-08-28", "12:00"))).toBe("away");
    w.events.shift(); // retention removed the Away row
    expect(modeAt(at("2026-08-28", "12:00"))).toBe("away"); // still right: the next row says what it changed from
  });

  it("an hours write that moves the mode records the FROM mode too", async () => {
    const w = world({ setAt: at("2026-09-23", "09:00") });
    const now = at("2026-09-23", "12:00");
    await writeHoursException(db(w).prisma, REQ_FOR_FROM, { date: "2026-09-23", day: { kind: "closed" }, note: "" }, 3, now);
    expect(w.events).toEqual([expect.objectContaining({ summary: "Closed (opening hours changed)", labels: ["closed", "schedule", "open"] })]);
  });

  // A re-created singleton restarts at version 0: a leftover site_mode:v1 row must never block every mode change.
  it("a leftover site_mode:v1 feed row from before a reset does not block the change (ON CONFLICT DO NOTHING)", async () => {
    const w = world({ version: 0 }, { events: [{ source: "site_mode", kind: "mode_changed", dedupeKey: "site_mode:v1", summary: "from before" }] });
    const r = await actOnMode(db(w).prisma, WHO, { action: "close" }, at("2026-09-23", "12:00"));
    expect(r).toMatchObject({ status: "ok", changed: true });
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "manual", version: 1 });
    expect(w.events).toHaveLength(1); // the leftover absorbed the new key; nothing thrown
    expect(h.inTx).toHaveBeenCalledTimes(1);
    // The ticker too.
    const w2 = world({ version: 0, setAt: at("2026-09-23", "09:00") }, { events: [{ source: "site_mode", kind: "mode_changed", dedupeKey: "site_mode:v1" }] });
    expect(await tickSecurityMode(db(w2).prisma, at("2026-09-23", "17:00:30"))).toEqual({ outcome: "changed" });
    expect(w2.mode).toMatchObject({ mode: "closed", version: 1 });
  });

  it("Open up 2 h at 20:00: the audit says until when, in the site zone", async () => {
    const w = world({ mode: "closed" });
    await actOnMode(db(w).prisma, WHO, { action: "open", for: "2h" }, at("2026-09-23", "20:00"));
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ what: "Security: opened up until 22:00", refs: { action: "mode.open", for: "2h" } });
    expect(w.events[0]).toMatchObject({ summary: "Opened by Maria until 10:00 PM" });
  });

  it("a lost race is re-read and re-planned once; the retry lands with ONE audit", async () => {
    const w = world();
    const { p, prisma } = db(w);
    p.securityModeState.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await actOnMode(prisma, WHO, { action: "away" }, at("2026-09-23", "12:00"));
    expect(r).toMatchObject({ status: "ok", changed: true });
    expect(p.securityModeState.updateMany).toHaveBeenCalledTimes(2);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });

  it("two lost races → conflict, nothing written", async () => {
    const w = world();
    const { p, prisma } = db(w);
    p.securityModeState.updateMany.mockResolvedValue({ count: 0 });
    expect(await actOnMode(prisma, WHO, { action: "away" }, at("2026-09-23", "12:00"))).toEqual({ status: "conflict" });
    expect(h.inTx).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });

  it("unreadable hours → throws (the route answers 503), never a guess", async () => {
    const w = world({}, { hours: defaultHours({ state: "set", timezone: "Mars/Base" }) });
    await expect(actOnMode(db(w).prisma, WHO, { action: "close" }, at("2026-09-23", "12:00"))).rejects.toThrow(/can't be read/);
  });

  it("Back to opening hours: the view names no setter (setBy only while a manual mode is in force)", async () => {
    const w = world(
      { mode: "away", modeSource: "manual", manualEnd: "until_changed", setById: MARIA, setAt: at("2026-09-23", "10:00") },
      { users: { [MARIA]: { displayName: "Maria", username: "maria" } } },
    );
    const { prisma } = db(w);
    const now = at("2026-09-23", "12:00");
    const r = await actOnMode(prisma, WHO, { action: "resume" }, now);
    expect(r).toMatchObject({ status: "ok", changed: true, mode: { mode: "open", source: "schedule", setBy: null } });
    expect((await readModeView(prisma, now)).setBy).toBeNull();
  });

  // The ≤ 60 s after a boundary, before the ticker has written it down.
  it("a person acting before the ticker wrote a flip: the flip lands first (at the boundary), then theirs — both in the feed", async () => {
    const w = world({ mode: "closed", setAt: at("2026-09-22", "17:00") });
    const now = at("2026-09-23", "09:00:30");
    const { p, prisma } = db(w);
    const r = await actOnMode(prisma, WHO, { action: "close" }, now);
    expect(r).toMatchObject({ status: "ok", changed: true, mode: { mode: "closed", source: "manual", manualEnd: "next_opening" } });
    // The catch-up's CAS, then the person's — planned from the caught-up row, so no lost race.
    expect(p.securityModeState.updateMany).toHaveBeenCalledTimes(2);
    expect(w.events).toEqual([
      expect.objectContaining({ summary: "Open (opening hours)", startedAt: at("2026-09-23", "09:00"), labels: ["open", "schedule", "closed"], dedupeKey: "site_mode:v1" }),
      expect.objectContaining({ summary: "Closed up by Maria", startedAt: now, labels: ["closed", "manual", "open"], dedupeKey: "site_mode:v2" }),
    ]);
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "manual", manualUntil: at("2026-09-24", "09:00"), version: 2 });
    expect(h.record).not.toHaveBeenCalled(); // a schedule flip is never audited
    expect(h.inTx).toHaveBeenCalledTimes(1);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ refs: { action: "mode.close", from: "open", fromSource: "schedule" } });
  });

  it("an override that ended before the ticker saw it is audited as ended, before the person's own change", async () => {
    const w = world({
      mode: "open",
      modeSource: "manual",
      manualEnd: "at_time",
      manualUntil: at("2026-09-23", "19:00"),
      setById: MARIA,
      setAt: at("2026-09-23", "17:30"),
    });
    const now = at("2026-09-23", "19:00:30");
    const r = await actOnMode(db(w).prisma, WHO, { action: "away" }, now);
    expect(r).toMatchObject({ status: "ok", changed: true, mode: { mode: "away" } });
    expect(w.events).toEqual([
      expect.objectContaining({ summary: "Closed (opening hours)", startedAt: at("2026-09-23", "19:00"), labels: ["closed", "schedule", "open"] }),
      expect.objectContaining({ summary: "Set to away by Maria", startedAt: now, labels: ["away", "manual", "closed"] }),
    ]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toMatchObject({ actor: { type: "system" }, refs: { action: "mode.expire", endedMode: "open" } });
    expect(h.inTx).toHaveBeenCalledTimes(1);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ refs: { action: "mode.away", from: "closed", fromSource: "schedule" } });
  });

  it("a person's catch-up is not the ticker's check: a stalled ticker stays down, and its 'since' keeps the real time", async () => {
    const w = world({ mode: "closed", setAt: at("2026-09-22", "17:00") });
    const { p, prisma } = db(w);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-23", "08:00"));
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, prisma); // registered, never fires
    // The catch-up's own read fails once: that is the request's error, not the ticker's.
    const real = p.securitySiteHours.findUnique.getMockImplementation()!;
    let reads = 0;
    p.securitySiteHours.findUnique.mockImplementation(async () => {
      if (++reads === 2) throw new Error("db blip");
      return real();
    });
    const r = await actOnMode(prisma, WHO, { action: "away" }, at("2026-09-23", "09:05"));
    expect(r).toMatchObject({ status: "ok", changed: true, mode: { mode: "away", stale: true } });
    expect(siteModeHealthState()).toMatchObject({ lastOkAt: null, lastError: null });
    // A catch-up that succeeds does not count either.
    const w2 = world({ mode: "closed", setAt: at("2026-09-22", "17:00") });
    expect(await actOnMode(db(w2).prisma, WHO, { action: "away" }, at("2026-09-23", "09:05"))).toMatchObject({ status: "ok", changed: true });
    expect(w2.events[0]).toMatchObject({ summary: "Open (opening hours)" }); // the catch-up did run
    expect(siteModeHealthState()).toMatchObject({ lastOkAt: null, lastError: null });
    expect(siteModeHealthRow(siteModeHealthState(), { state: "set", timezone: TZ }, w2.mode, at("2026-09-23", "09:07"))).toMatchObject({
      state: "down",
      detail: "Hasn't checked the opening hours since 8:00 AM",
    });
  });

  it("a failed catch-up (the system audit throws) never blocks the person's change", async () => {
    const w = world({ mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "19:00"), setById: MARIA });
    h.record.mockRejectedValueOnce(new Error("chain down"));
    const r = await actOnMode(db(w).prisma, WHO, { action: "away" }, at("2026-09-23", "19:00:30"));
    expect(r).toMatchObject({ status: "ok", changed: true, mode: { mode: "away" } });
    expect(w.events.map((e) => e.summary)).toEqual(["Closed (opening hours)", "Set to away by Maria"]);
    expect(h.inTx).toHaveBeenCalledTimes(1);
  });
});

// ── hours writes ──────────────────────────────────────────────────────────

const REQ = WHO.req;
function days7(spec: Array<"closed" | "all" | [string, string]>) {
  return spec.map((s, i) =>
    s === "closed"
      ? { weekday: i + 1, kind: "closed" as const }
      : s === "all"
        ? { weekday: i + 1, kind: "open_all_day" as const }
        : { weekday: i + 1, kind: "hours" as const, opensMin: Number(s[0].slice(0, 2)) * 60, closesMin: Number(s[1].slice(0, 2)) * 60 },
  );
}

describe("writeSiteHours", () => {
  it("a stale expectedVersion → version_conflict, nothing changed", async () => {
    const w = world();
    expect(await writeSiteHours(db(w).prisma, REQ, { state: "not_set" }, 2, at("2026-09-23", "12:00"))).toEqual({
      status: "version_conflict",
    });
    expect(w.hours!.version).toBe(3);
    expect(w.days).toHaveLength(7);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("ALWAYS bumps the mode version (a tick that read the old hours must lose), even when the mode is unchanged", async () => {
    const w = world({ version: 10 });
    const r = await writeSiteHours(
      db(w).prisma,
      REQ,
      { state: "set", timezone: TZ, days: days7([["08", "18"], ["08", "18"], ["08", "18"], ["08", "18"], ["08", "18"], "closed", "closed"]) },
      3,
      at("2026-09-23", "12:00"),
    );
    expect(r).toEqual({ status: "ok", effect: "unchanged" });
    expect(w.mode!.version).toBe(11);
    expect(w.hours).toMatchObject({ state: "set", timezone: TZ, version: 4, updatedById: MARIA });
    expect(w.days.map((d) => d.opensMin)).toEqual([480, 480, 480, 480, 480, null, null]);
    expect(w.events).toEqual([]);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({
      what: "Security: opening hours changed",
      refs: { surface: "security", action: "hours.set", timezone: TZ, modeEffect: "unchanged" },
    });
    expect(h.inTx.mock.calls[0]![1].refs.days[0]).toEqual({ weekday: 1, kind: "hours", opens: "08:00", closes: "18:00" });
  });

  it("a schedule-following mode moves with the hours, with a feed row", async () => {
    const w = world();
    const now = at("2026-09-23", "12:00");
    const r = await writeSiteHours(db(w).prisma, REQ, { state: "set", timezone: TZ, days: days7(["closed", "closed", "closed", "closed", "closed", "closed", "closed"]) }, 3, now);
    expect(r).toEqual({ status: "ok", effect: "mode_changed" });
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "schedule", version: 1 });
    expect(w.events).toEqual([expect.objectContaining({ summary: "Closed (opening hours changed)", startedAt: now, dedupeKey: "site_mode:v1" })]);
    expect(h.inTx.mock.calls[0]![1].refs.modeEffect).toBe("mode_changed");
  });

  it("a Close up re-aims at the NEW hours' next opening, keeping who set it", async () => {
    const setAt = at("2026-09-23", "11:00");
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00"), setById: MARIA, setAt });
    const r = await writeSiteHours(
      db(w).prisma,
      REQ,
      { state: "set", timezone: TZ, days: days7([["10", "17"], ["10", "17"], ["10", "17"], ["10", "17"], ["10", "17"], "closed", "closed"]) },
      3,
      at("2026-09-23", "12:00"),
    );
    expect(r).toEqual({ status: "ok", effect: "until_moved" });
    expect(w.mode).toMatchObject({ mode: "closed", manualEnd: "next_opening", manualUntil: at("2026-09-24", "10:00"), setById: MARIA, setAt });
    expect(w.events).toEqual([]);
  });

  it("clearing the hours: special days go, a Close up holds until changed, the schedule mode opens", async () => {
    const w = world(
      { mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00") },
      { exceptions: [{ date: "2026-12-25", kind: "closed", opensMin: null, closesMin: null, note: "", createdById: null, createdAt: new Date(), updatedAt: new Date() }] },
    );
    const r = await writeSiteHours(db(w).prisma, REQ, { state: "not_set" }, 3, at("2026-09-23", "12:00"));
    expect(r).toEqual({ status: "ok", effect: "until_changed" });
    expect(w.hours).toMatchObject({ state: "not_set", timezone: null });
    expect(w.days).toEqual([]);
    expect(w.exceptions).toEqual([]);
    expect(w.mode).toMatchObject({ mode: "closed", manualEnd: "until_changed", manualUntil: null });
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ what: "Security: opening hours cleared", refs: { action: "hours.clear", modeEffect: "until_changed" } });

    const w2 = world({ mode: "closed" });
    expect(await writeSiteHours(db(w2).prisma, REQ, { state: "not_set" }, 3, at("2026-09-23", "20:00"))).toEqual({ status: "ok", effect: "mode_changed" });
    expect(w2.mode).toMatchObject({ mode: "open", modeSource: "schedule" });
  });

  it("an override that had already ended under the OLD hours is not revived by the edit — its end is caught up first, at 09:00, by the system", async () => {
    // Closed up until Wed 09:00; it is Wed 12:00 (expired, not yet ticked). New hours open at 10:00.
    const w = world({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-23", "09:00"), setById: MARIA });
    const r = await writeSiteHours(
      db(w).prisma,
      REQ,
      { state: "set", timezone: TZ, days: days7([["10", "17"], ["10", "17"], ["10", "17"], ["10", "17"], ["10", "17"], "closed", "closed"]) },
      3,
      at("2026-09-23", "12:00"),
    );
    // The catch-up already moved it: the edit itself changes nothing.
    expect(r).toEqual({ status: "ok", effect: "unchanged" });
    expect(w.events).toEqual([
      expect.objectContaining({ summary: "Open (opening hours)", startedAt: at("2026-09-23", "09:00"), labels: ["open", "schedule", "closed"] }),
    ]);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0]).toMatchObject({ actor: { type: "system" }, refs: { action: "mode.expire", endedMode: "closed" } });
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ refs: { action: "hours.set", modeEffect: "unchanged" } });
    // Following the hours again: nobody "set" it any more.
    expect(w.mode).toMatchObject({ mode: "open", modeSource: "schedule", manualUntil: null, setById: null });
  });

  it("every opening-hours write is ONE READ COMMITTED transaction (the in-tx audit's precondition)", async () => {
    const w = world({}, { exceptions: [{ date: "2026-12-25", kind: "closed", opensMin: null, closesMin: null, note: "", createdById: null, createdAt: new Date(), updatedAt: new Date() }] });
    const { p, prisma } = db(w);
    const now = at("2026-09-23", "12:00");
    expect(await writeHoursException(prisma, REQ, { date: "2026-12-24", day: { kind: "closed" }, note: "" }, 3, now)).toMatchObject({ status: "ok" });
    expect(await deleteHoursException(prisma, REQ, "2026-12-24", 4, now)).toMatchObject({ status: "ok" });
    expect(await writeSiteHours(prisma, REQ, { state: "not_set" }, 5, now)).toMatchObject({ status: "ok" });
    // Every other transaction is the catch-up's read-only snapshot.
    const opts = p.$transaction.mock.calls.map((c) => c[1]);
    expect(opts.filter((o) => JSON.stringify(o) === JSON.stringify({ isolationLevel: "ReadCommitted" }))).toHaveLength(3);
    for (const o of opts) expect([{ isolationLevel: "ReadCommitted" }, { isolationLevel: "RepeatableRead" }]).toContainEqual(o);
  });

  // An hours write inside the ticker's lag: the missed flip / expiry lands first, as the ticker would write it.
  it.each([
    [
      "a special day added at 17:00:30, before the 17:00 flip was ticked",
      world({ setAt: at("2026-09-23", "09:00") }),
      at("2026-09-23", "17:00:30"),
      "Closed (opening hours)",
      at("2026-09-23", "17:00"),
      0,
    ],
    [
      "a special day added at 19:00:30, after an Open up ended at 19:00",
      world({ mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "19:00"), setById: MARIA, setAt: at("2026-09-23", "17:30") }),
      at("2026-09-23", "19:00:30"),
      "Closed (opening hours)",
      at("2026-09-23", "19:00"),
      1,
    ],
  ])("%s: the missed change is written at its boundary by the system, then the edit's own audit says 'unchanged'", async (_l, w, now, summary, startedAt, expiries) => {
    const r = await writeHoursException(db(w).prisma, REQ, { date: "2026-12-25", day: { kind: "closed" }, note: "" }, 3, now);
    expect(r).toEqual({ status: "ok", effect: "unchanged" });
    expect(w.events).toEqual([expect.objectContaining({ summary, startedAt, labels: ["closed", "schedule", "open"] })]);
    expect(h.record).toHaveBeenCalledTimes(expiries);
    if (expiries) expect(h.record.mock.calls[0]![0]).toMatchObject({ actor: { type: "system" }, refs: { action: "mode.expire", endedMode: "open" } });
    expect(h.inTx).toHaveBeenCalledTimes(1);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ refs: { action: "exception.set", modeEffect: "unchanged" } });
  });

  it("removing a special day inside the lag catches up first too", async () => {
    const w = world(
      { setAt: at("2026-09-23", "09:00") },
      { exceptions: [{ date: "2026-12-25", kind: "closed", opensMin: null, closesMin: null, note: "", createdById: null, createdAt: new Date(), updatedAt: new Date() }] },
    );
    expect(await deleteHoursException(db(w).prisma, REQ, "2026-12-25", 3, at("2026-09-23", "17:00:30"))).toEqual({ status: "ok", effect: "unchanged" });
    expect(w.events).toEqual([expect.objectContaining({ summary: "Closed (opening hours)", startedAt: at("2026-09-23", "17:00") })]);
  });

  it("an audit failure rolls back the hours AND the mode bump", async () => {
    const w = world({ version: 10 });
    h.inTx.mockRejectedValueOnce(new Error("chain down"));
    await expect(writeSiteHours(db(w).prisma, REQ, { state: "not_set" }, 3, at("2026-09-23", "12:00"))).rejects.toBeInstanceOf(
      SecurityAuditUnavailableError,
    );
    expect(w.hours).toMatchObject({ state: "set", version: 3 });
    expect(w.days).toHaveLength(7);
    expect(w.mode!.version).toBe(10);
  });
});

describe("writeHoursException / deleteHoursException", () => {
  const NOW = at("2026-09-23", "12:00");
  const lateNight = { kind: "hours" as const, opensMin: 18 * 60, closesMin: 23 * 60 };

  it("needs hours first → hours_not_set", async () => {
    const w = world({}, { hours: defaultHours() });
    expect(await writeHoursException(db(w).prisma, REQ, { date: "2026-09-27", day: lateNight, note: "" }, 0, NOW)).toEqual({
      status: "hours_not_set",
    });
  });

  it("from site-local yesterday to today + 366 → else out_of_range", async () => {
    const w = world();
    const { prisma } = db(w);
    expect(await writeHoursException(prisma, REQ, { date: "2026-09-21", day: lateNight, note: "" }, 3, NOW)).toEqual({ status: "out_of_range" });
    expect(await writeHoursException(prisma, REQ, { date: "2027-09-25", day: lateNight, note: "" }, 3, NOW)).toEqual({ status: "out_of_range" });
    expect(w.hours!.version).toBe(3);
    expect(await writeHoursException(prisma, REQ, { date: "2026-09-22", day: lateNight, note: "" }, 3, NOW)).toMatchObject({ status: "ok" });
    expect(await writeHoursException(prisma, REQ, { date: "2027-09-24", day: lateNight, note: "" }, 4, NOW)).toMatchObject({ status: "ok" });
  });

  it("sets a day, bumps both versions, moves the mode, audits with the note", async () => {
    const w = world({ version: 2 });
    const r = await writeHoursException(db(w).prisma, REQ, { date: "2026-09-23", day: { kind: "closed" }, note: "Staff training" }, 3, NOW);
    expect(r).toEqual({ status: "ok", effect: "mode_changed" });
    expect(w.exceptions).toEqual([expect.objectContaining({ date: "2026-09-23", kind: "closed", note: "Staff training", createdById: MARIA })]);
    expect(w.hours!.version).toBe(4);
    expect(w.mode).toMatchObject({ mode: "closed", modeSource: "schedule", version: 3 });
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({
      what: "Security: special day 2026-09-23 set",
      refs: { action: "exception.set", date: "2026-09-23", kind: "closed", opens: null, closes: null, note: "Staff training", replaced: false, modeEffect: "mode_changed" },
    });
  });

  it("a stale version → version_conflict", async () => {
    const w = world();
    expect(await writeHoursException(db(w).prisma, REQ, { date: "2026-09-27", day: lateNight, note: "" }, 1, NOW)).toEqual({
      status: "version_conflict",
    });
  });

  it("100 upcoming special days → exception_limit, and the version bump rolls back", async () => {
    const future = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 1 + i));
      return { date: d.toISOString().slice(0, 10), kind: "closed" as const, opensMin: null, closesMin: null, note: "", createdById: null, createdAt: new Date(), updatedAt: new Date() };
    });
    const w = world({}, { exceptions: future });
    expect(await writeHoursException(db(w).prisma, REQ, { date: "2026-09-27", day: lateNight, note: "" }, 3, NOW)).toEqual({
      status: "exception_limit",
    });
    expect(w.hours!.version).toBe(3);
    expect(w.exceptions).toHaveLength(100);
    // Replacing one that exists is fine.
    expect(await writeHoursException(db(w).prisma, REQ, { date: future[0]!.date, day: lateNight, note: "" }, 3, NOW)).toMatchObject({ status: "ok" });
    // So is site-local yesterday: the limit counts days from today on.
    expect(await writeHoursException(db(w).prisma, REQ, { date: "2026-09-22", day: lateNight, note: "" }, 4, NOW)).toMatchObject({ status: "ok" });
    expect(w.exceptions).toHaveLength(101);
    // …and the page shows all of them: the furthest day is never cut off where nobody could remove it.
    const view = await readHoursView(db(w).prisma, NOW, { profileHint: false });
    expect(view.exceptions).toHaveLength(101);
    expect(view.exceptions[100]!.date).toBe(future[99]!.date);
  });

  it("delete: not_found rolls the CAS back; found → removed and audited", async () => {
    const w = world({}, { exceptions: [{ date: "2026-12-25", kind: "closed", opensMin: null, closesMin: null, note: "", createdById: null, createdAt: new Date(), updatedAt: new Date() }] });
    const { prisma } = db(w);
    expect(await deleteHoursException(prisma, REQ, "2026-12-24", 3, NOW)).toEqual({ status: "not_found" });
    expect(w.hours!.version).toBe(3);
    expect(await deleteHoursException(prisma, REQ, "2026-12-25", 2, NOW)).toEqual({ status: "version_conflict" });
    expect(await deleteHoursException(prisma, REQ, "2026-12-25", 3, NOW)).toEqual({ status: "ok", effect: "unchanged" });
    expect(w.exceptions).toEqual([]);
    expect(w.hours!.version).toBe(4);
    expect(h.inTx.mock.calls[0]![1]).toMatchObject({ refs: { action: "exception.delete", date: "2026-12-25" } });
  });
});

// ── views ─────────────────────────────────────────────────────────────────

describe("readModeView", () => {
  it("the EFFECTIVE mode, the site zone, the upcoming change; a row lagging less than the grace is NOT stale", async () => {
    // 20 s after the 17:00 boundary the ticker has not written "closed" yet.
    // The view already says closed, so the card must not warn.
    const w = world({ mode: "open", setAt: at("2026-09-23", "09:00") });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-23", "17:00"));
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, db(w).prisma);
    const v = await readModeView(db(w).prisma, at("2026-09-23", "17:00:20"));
    expect(v).toMatchObject({
      mode: "closed",
      source: "schedule",
      manualEnd: "none",
      until: null,
      setBy: null,
      setAt: at("2026-09-23", "17:00").toISOString(),
      hours: { state: "set", timezone: TZ, scheduledMode: "closed", upcoming: { at: at("2026-09-24", "09:00").toISOString(), mode: "open" } },
      displayTimezone: TZ,
      stale: false,
      version: 0,
    });
  });

  // Both sides of the grace, with a HEALTHY ticker (registered 2 min after
  // the boundary, so its own start-up grace keeps the health row up): only
  // the length of the lag decides. `>`, like the health row: exactly one
  // grace is not yet "longer than" it.
  it.each([
    ["a schedule flip the ticker has not written", { mode: "open" as const, setAt: at("2026-09-23", "09:00") }, at("2026-09-23", "17:00")],
    [
      "a Close up that ended at the opening",
      {
        mode: "closed" as const,
        modeSource: "manual" as const,
        manualEnd: "next_opening" as const,
        manualUntil: at("2026-09-24", "09:00"),
        setAt: at("2026-09-23", "17:30"),
      },
      at("2026-09-24", "09:00"),
    ],
  ])("%s: lagging exactly the grace → not stale; 1 ms longer → stale", async (_l, stored, since) => {
    const w = world(stored);
    const { prisma } = db(w);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(since.getTime() + 2 * 60_000));
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, prisma);
    const edge = new Date(since.getTime() + SECURITY_SITE_MODE_GRACE_MS);
    const inside = await readModeView(prisma, edge);
    expect(inside.setAt).toBe(since.toISOString());
    expect(siteModeHealthRow(siteModeHealthState(), { state: "set", timezone: TZ }, w.mode, edge).state).toBe("ok");
    expect(inside.stale).toBe(false);
    const past = new Date(edge.getTime() + 1);
    expect(siteModeHealthRow(siteModeHealthState(), { state: "set", timezone: TZ }, w.mode, past).state).toBe("ok");
    expect((await readModeView(prisma, past)).stale).toBe(true);
  });

  it("stale when the health row is down, even with a lag well inside the grace", async () => {
    // Registered an hour before and never checked since: down "Hasn't checked…".
    const w = world({ mode: "open", setAt: at("2026-09-23", "09:00") });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-23", "16:00"));
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, db(w).prisma);
    const now = at("2026-09-23", "17:00:10");
    expect(siteModeHealthRow(siteModeHealthState(), { state: "set", timezone: TZ }, w.mode, now).state).toBe("down");
    expect((await readModeView(db(w).prisma, now)).stale).toBe(true);
  });

  it("in sync with a running ticker → not stale; setBy names the person", async () => {
    const w = world(
      { mode: "away", modeSource: "manual", manualEnd: "until_changed", setById: MARIA, setAt: at("2026-09-23", "10:00") },
      { users: { [MARIA]: { displayName: "Maria", username: "maria" } } },
    );
    const now = at("2026-09-23", "12:00");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { prisma } = db(w);
    registerSecurityModeJobs({ scheduleInterval: vi.fn() }, prisma);
    await tickSecurityMode(prisma, now);
    const v = await readModeView(prisma, now);
    expect(v).toMatchObject({ mode: "away", source: "manual", setBy: { id: MARIA, name: "Maria" }, stale: false });
  });

  it("stale when the ticker is not running, even if the row is in sync", async () => {
    const w = world({ mode: "open" });
    expect((await readModeView(db(w).prisma, at("2026-09-23", "12:00"))).stale).toBe(true);
  });

  it.each([
    ["a valid Workspace.tz (canonicalised)", "us/eastern", "America/New_York"],
    ["an invalid Workspace.tz", "Mars/Base", null],
    ["no Workspace.tz", null, null],
  ])("hours not set, %s → displayTimezone %s — never UTC", async (_l, tz, expected) => {
    const w = newWorld({ workspaceTz: tz });
    const v = await readModeView(db(w).prisma, at("2026-09-23", "12:00"));
    expect(v.hours).toEqual({ state: "not_set" });
    expect(v.displayTimezone).toBe(expected);
    expect(v.mode).toBe("open");
  });

  it("unknown site zone → throws (503 at the route), never a fake open", async () => {
    const w = world({}, { hours: defaultHours({ state: "set", timezone: "Mars/Base" }) });
    await expect(readModeView(db(w).prisma, at("2026-09-23", "12:00"))).rejects.toThrow(/can't be read/);
  });
});

describe("readHoursView", () => {
  it("Monday first, times as HH:MM, special days from site-local yesterday, a 7-day preview, the hint", async () => {
    const mk = (date: string) => ({ date, kind: "hours" as const, opensMin: 600, closesMin: 840, note: "n", createdById: null, createdAt: new Date(), updatedAt: new Date() });
    const w = world({}, { exceptions: [mk("2026-09-21"), mk("2026-09-22"), mk("2026-10-01")], workspaceTz: "Europe/Paris", typicalDay: "We open at nine." });
    const now = at("2026-09-23", "12:00");
    const v = await readHoursView(db(w).prisma, now, { profileHint: true });
    expect(v.state).toBe("set");
    expect(v.timezone).toBe(TZ);
    expect(v.version).toBe(3);
    expect(v.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(v.days[0]).toEqual({ weekday: 1, kind: "hours", opens: "09:00", closes: "17:00" });
    expect(v.days[6]).toEqual({ weekday: 7, kind: "closed", opens: null, closes: null });
    expect(v.exceptions.map((e) => e.date)).toEqual(["2026-09-22", "2026-10-01"]);
    expect(v.exceptions[0]).toEqual({ date: "2026-09-22", kind: "hours", opens: "10:00", closes: "14:00", note: "n" });
    expect(v.preview[0]).toEqual({ startsAt: now.toISOString(), endsAt: at("2026-09-23", "17:00").toISOString() });
    expect(v.preview).toHaveLength(6);
    expect(v.hint).toEqual({ workspaceTimezone: "Europe/Paris", typicalDay: "We open at nine." });
  });

  it("not set: seven closed days, no preview, version 0 from the lazily created row", async () => {
    const w = newWorld();
    const v = await readHoursView(db(w).prisma, at("2026-09-23", "12:00"), { profileHint: false });
    expect(v).toMatchObject({ state: "not_set", timezone: null, version: 0, exceptions: [], preview: [] });
    expect(v.days.every((d) => d.kind === "closed")).toBe(true);
    expect(w.hours).not.toBeNull();
  });

  it("without profileHint the typical day is '' and the business profile is not even read (the §15 ladder: family sees the summary only)", async () => {
    const w = world({}, { typicalDay: "Owner opens alone at 5am." });
    const { p, prisma } = db(w);
    const v = await readHoursView(prisma, at("2026-09-23", "12:00"), { profileHint: false });
    expect(v.hint.typicalDay).toBe("");
    expect(p.businessProfile.findUnique).not.toHaveBeenCalled();
  });
});

describe("summaryName", () => {
  it("strips control characters and lone surrogates, caps at 60, never empty", () => {
    expect(summaryName("Ma\u0000ria\n")).toBe("Maria");
    expect(summaryName("A\uD800B")).toBe("AB");
    expect(summaryName("x".repeat(80))).toHaveLength(60);
    expect(summaryName("   ")).toBe("someone");
    expect(summaryName(null)).toBe("someone");
  });

  // A self-edited display name lands in an append-only feed row every Security viewer reads.
  it.each([
    ["a right-to-left override", "Maria\u202Eairam", "Mariaairam"],
    ["a right-to-left isolate", "Maria\u2067x", "Mariax"],
    ["a C1 control (NEL)", "Ma\u0085ria", "Maria"],
    ["a line separator", "Ma\u2028ria", "Maria"],
    ["a paragraph separator", "Ma\u2029ria", "Maria"],
    ["a BOM", "\uFEFFMaria", "Maria"],
    ["only an override", "\u202E", "someone"],
  ])("strips %s", (_n, raw, want) => {
    expect(summaryName(raw)).toBe(want);
  });

  it("keeps what real names need: ZWNJ (Persian), ZWJ (emoji), and the direction marks", () => {
    expect(summaryName("می\u200Cخواهم")).toBe("می\u200Cخواهم");
    expect(summaryName("Sam \u{1F469}\u200D\u{1F4BB}")).toBe("Sam \u{1F469}\u200D\u{1F4BB}");
    expect(summaryName("Maria\u200F")).toBe("Maria\u200F");
  });
});
