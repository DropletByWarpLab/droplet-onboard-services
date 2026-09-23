/**
 * WARP-2977 P2b — the site mode and the opening hours against REAL Postgres.
 *
 * WHY THESE RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   races     — "two Close ups land once" and "an hours edit beats a tick
 *               that read the old hours" rest on READ COMMITTED's
 *               re-evaluation of the CAS predicate (EvalPlanQual) after a
 *               row-lock wait. Only Postgres does that.
 *   rollback  — a failed in-transaction audit must leave NO ActivityRow and
 *               no change, and the chain must still verify.
 *
 * The CHECK constraints on these tables (SecurityModeState, SecuritySiteHours,
 * SecuritySchedule(Exception), and the site_mode SecurityEvent shape) are
 * pinned in ONE place: security-schema-checks.pg.test.ts.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 *
 * FIXTURE SCOPING — the DB is shared by the pg suites (never a TRUNCATE, never
 * an unscoped delete of shared rows):
 *   · ActivityRow — the chain's tail is recorded before the file
 *     (`chainFloor`); every count, walk and delete here is of the rows after
 *     it (`afterFloor`, `verifyActivityChain(…, floor)`, `deleteAfterFloor`).
 *   · SecurityEvent — only `site_mode:v<N>` dedupe keys, which only this
 *     service writes (other files' site_mode fixtures carry their own tag).
 *   · SecuritySiteHours / SecurityModeState / SecuritySchedule /
 *     SecurityScheduleException — whole-site settings: two singletons
 *     (CHECK id = 'singleton'), one row per weekday, one per date. The service
 *     reads them unfiltered, so they cannot be tagged; clearing them IS the
 *     scope. This file and security-schema-checks.pg.test.ts (which writes
 *     them only inside rolled-back transactions) therefore rely on the lane's
 *     --no-file-parallelism, which it already needs (rbac-v2 rail 5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import { createActivityRecorder } from "./activity.service.js";
import { createHmacSigner } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { SecurityAuditUnavailableError } from "./security-audit.js";
import {
  _resetSiteModeHealthForTests,
  actOnMode,
  readHoursView,
  readModeView,
  tickSecurityMode,
  writeSiteHours,
} from "./security-mode.service.js";
import { zonedWallClockToUtc } from "../lib/zoned-time.js";
import {
  afterFloor,
  appendForeignRow,
  chainFloor,
  deleteAfterFloor,
  removeForeignRow,
  type ChainFloor,
} from "../__tests__/helpers/activity-chain-floor.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2977b";
const TZ = "Europe/London";
const CHAIN_LOCK_KEY = "droplet:activity-chain-append";
/** The mode_changed rows this service writes (dedupeKey `site_mode:v<N>`); other files' site_mode fixtures carry their own tag. */
const MODE_ROWS = { source: "site_mode" as const, dedupeKey: { startsWith: "site_mode:v" } };

function at(ymd: string, time: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, h!, mi!, 0, TZ);
}

const USERS = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442", "44444444-4444-4444-8444-444444444443"];
const who = (i: number) => ({ req: { user: { id: USERS[i % USERS.length]!, role: "family" } }, id: USERS[i % USERS.length]!, name: `Tester ${i}` });

describe.skipIf(!RUN)("site mode + opening hours — real Postgres (WARP-2977 P2b)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let foreignRowId = 0n;
  const signer = createHmacSigner(Buffer.alloc(32, 9));
  const mine = () => ({ where: afterFloor(floor) });

  async function clean() {
    await prisma.securityEvent.deleteMany({ where: MODE_ROWS });
    await prisma.securityScheduleException.deleteMany({});
    await prisma.securitySchedule.deleteMany({});
    await prisma.securitySiteHours.deleteMany({ where: { id: "singleton" } });
    await prisma.securityModeState.deleteMany({ where: { id: "singleton" } });
    await deleteAfterFloor(prisma, floor);
  }

  /** Mon–Fri 09:00–17:00 in London, stored mode schedule/open at version 0. */
  async function seedWeekdays(setAt = at("2026-09-23", "09:00")) {
    await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: TZ, version: 1 } });
    await prisma.securitySchedule.createMany({
      data: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
        weekday <= 5
          ? { weekday, kind: "hours" as const, opensMin: 540, closesMin: 1020 }
          : { weekday, kind: "closed" as const, opensMin: null, closesMin: null },
      ),
    });
    await prisma.securityModeState.create({ data: { id: "singleton", setAt } });
  }

  function useRecorder(on: boolean) {
    _setActivityRecorderForTests(on ? createActivityRecorder({ prisma, signer }) : null, on ? signer : null);
  }

  /** Poll pg_locks until `sql` counts at least one row (a session is waiting where we expect it). */
  async function waitFor(sql: string, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql);
      if (Number(rows[0]?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new Real();
    await prisma.$connect();
    // Another file's row, under another key: this file must neither delete it nor walk it.
    foreignRowId = await appendForeignRow(prisma, `${TAG} another file's row`);
    floor = await chainFloor(prisma);
  });

  afterAll(async () => {
    await clean();
    const foreignRowKept = await removeForeignRow(prisma, foreignRowId);
    _setActivityRecorderForTests(null, null);
    await prisma.$disconnect();
    expect(foreignRowKept).toBe(true);
  });

  beforeEach(async () => {
    await clean();
    _resetSiteModeHealthForTests();
    useRecorder(true);
  });

  // ── races ───────────────────────────────────────────────────────────────

  it("concurrent Close ups: exactly one version bump, one mode_changed row, one ActivityRow", async () => {
    await seedWeekdays();
    const now = at("2026-09-23", "12:00");
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => actOnMode(prisma, who(i), { action: "close" }, now)));
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results.filter((r) => r.status === "ok" && r.changed)).toHaveLength(1);
    const state = await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state).toMatchObject({ version: 1, mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: at("2026-09-24", "09:00") });
    const rows = await prisma.securityEvent.findMany({ where: MODE_ROWS });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "mode_changed", dedupeKey: "site_mode:v1", labels: ["closed", "manual", "open"], camera: null });
    expect(await prisma.activityRow.count(mine())).toBe(1);
    expect((await verifyActivityChain(prisma, signer, floor)).ok).toBe(true);
  });

  it("an hours edit racing a tick: the tick read the OLD hours, the edit commits first, the tick's CAS fails", async () => {
    await seedWeekdays();
    // The edit lands at 16:59, when nothing lags (its own catch-up has nothing to write).
    // The tick runs at 18:00: closed by the old hours, stored still says open → it wants to flip.
    const editAt = at("2026-09-23", "16:59");
    const now = at("2026-09-23", "18:00");
    const everyDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, kind: "open_all_day" as const }));

    // Hold the chain lock so the hours transaction parks at its audit — AFTER its
    // CAS, its row replacement and its SecurityModeState bump, all uncommitted.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT (pg_advisory_xact_lock(hashtext('${CHAIN_LOCK_KEY}')) IS NULL) AS locked`);
        await gate;
      },
      { timeout: 30_000 },
    );
    await waitFor(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
      "the chain lock to be held",
    );

    const edit = writeSiteHours(prisma, who(0).req, { state: "set", timezone: TZ, days: everyDay }, 1, editAt);
    await waitFor(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      "the hours edit to wait on the chain lock",
    );

    // The tick reads the committed (old) hours and the committed mode (v0), plans the
    // 17:00 flip to closed, and its CAS then waits on the edit's row lock.
    const tick = tickSecurityMode(prisma, now);
    await waitFor(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype <> 'advisory' AND NOT granted`,
      "the tick's CAS to wait on the mode row",
    );

    release();
    await holder;
    expect(await edit).toEqual({ status: "ok", effect: "unchanged" });
    expect(await tick).toEqual({ outcome: "conflict" });

    const state = await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state).toMatchObject({ version: 1, mode: "open", modeSource: "schedule" });
    expect(await prisma.securityEvent.count({ where: MODE_ROWS })).toBe(0);
    expect(await prisma.activityRow.count(mine())).toBe(1);
    // The next tick reads the new hours: open all day, nothing to do.
    expect(await tickSecurityMode(prisma, now)).toEqual({ outcome: "unchanged" });
  });

  it("a real schedule flip through the ticker: one row stamped at the boundary, no ActivityRow", async () => {
    await seedWeekdays(at("2026-09-23", "09:00"));
    expect(await tickSecurityMode(prisma, at("2026-09-23", "17:00:30"))).toEqual({ outcome: "changed" });
    const rows = await prisma.securityEvent.findMany({ where: MODE_ROWS });
    expect(rows).toEqual([expect.objectContaining({ startedAt: at("2026-09-23", "17:00"), labels: ["closed", "schedule", "open"], summary: "Closed (opening hours)" })]);
    expect(await prisma.activityRow.count(mine())).toBe(0);
    expect(await tickSecurityMode(prisma, at("2026-09-23", "17:01:30"))).toEqual({ outcome: "unchanged" });
    expect(await prisma.securityEvent.count({ where: MODE_ROWS })).toBe(1);
  });

  it("a person acting on an override the ticker has not yet ended: the expiry (and its system audit) lands first, then theirs", async () => {
    await seedWeekdays();
    await prisma.securityModeState.update({
      where: { id: "singleton" },
      data: { mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "19:00"), setById: USERS[1]!, setAt: at("2026-09-23", "17:30") },
    });
    const now = at("2026-09-23", "19:00:30");
    expect(await actOnMode(prisma, who(0), { action: "away" }, now)).toMatchObject({ status: "ok", changed: true });
    const rows = await prisma.securityEvent.findMany({ where: MODE_ROWS, orderBy: { startedAt: "asc" } });
    expect(rows.map((r) => [r.dedupeKey, r.labels, r.startedAt.toISOString()])).toEqual([
      ["site_mode:v1", ["closed", "schedule", "open"], at("2026-09-23", "19:00").toISOString()],
      ["site_mode:v2", ["away", "manual", "closed"], now.toISOString()],
    ]);
    const audit = await prisma.activityRow.findMany({ ...mine(), orderBy: { id: "asc" } });
    expect(audit.map((a) => (a.refs as { action?: string }).action)).toEqual(["mode.expire", "mode.away"]);
    expect(await verifyActivityChain(prisma, signer, floor)).toEqual({ ok: true, rowsChecked: 2, brokenAtId: null });
  });

  it("an hours edit inside the ticker's lag: the ended override's row and system audit land first, then the edit's audit", async () => {
    await seedWeekdays();
    await prisma.securityModeState.update({
      where: { id: "singleton" },
      data: { mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "19:00"), setById: USERS[1]!, setAt: at("2026-09-23", "17:30") },
    });
    const now = at("2026-09-23", "19:00:30");
    const everyDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, kind: "hours" as const, opensMin: 540, closesMin: 1020 }));
    expect(await writeSiteHours(prisma, who(0).req, { state: "set", timezone: TZ, days: everyDay }, 1, now)).toEqual({ status: "ok", effect: "unchanged" });
    const rows = await prisma.securityEvent.findMany({ where: MODE_ROWS, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.labels, r.summary, r.startedAt.toISOString()])).toEqual([
      [["closed", "schedule", "open"], "Closed (opening hours)", at("2026-09-23", "19:00").toISOString()],
    ]);
    const audit = await prisma.activityRow.findMany({ ...mine(), orderBy: { id: "asc" } });
    expect(audit.map((a) => [(a.refs as { action?: string }).action, (a.refs as { modeEffect?: string }).modeEffect ?? null])).toEqual([
      ["mode.expire", null],
      ["hours.set", "unchanged"],
    ]);
    expect(await verifyActivityChain(prisma, signer, floor)).toEqual({ ok: true, rowsChecked: 2, brokenAtId: null });
  });

  // ── one snapshot per plan ───────────────────────────────────────────────

  /**
   * `prisma`, with `hook(key, n, phase)` awaited around every delegate call
   * (`key` = 'model.method', `n` = its 1-based count across the top-level
   * client AND every interactive transaction it opens). A hook that runs a
   * write on the REAL client commits it at exactly that point.
   */
  function instrumented(hook: (key: string, n: number, phase: "before" | "after") => Promise<void>): PrismaClient {
    const counts = new Map<string, number>();
    const delegate = (target: object, model: string) =>
      new Proxy(target, {
        get(t, method) {
          const f = Reflect.get(t, method, t) as unknown;
          if (typeof f !== "function" || typeof method !== "string") return f;
          return async (...args: unknown[]) => {
            const key = `${model}.${method}`;
            const n = (counts.get(key) ?? 0) + 1;
            counts.set(key, n);
            await hook(key, n, "before");
            const r = await (f as (...a: unknown[]) => Promise<unknown>).apply(t, args);
            await hook(key, n, "after");
            return r;
          };
        },
      });
    const client = (target: object): PrismaClient =>
      new Proxy(target, {
        get(t, prop) {
          const v = Reflect.get(t, prop, t) as unknown;
          if (prop === "$transaction") {
            return (fn: unknown, opts?: unknown) =>
              typeof fn === "function"
                ? (v as (f: unknown, o?: unknown) => Promise<unknown>).call(t, (tx: object) => (fn as (c: PrismaClient) => unknown)(client(tx)), opts)
                : (v as (f: unknown, o?: unknown) => Promise<unknown>).call(t, fn, opts);
          }
          if (typeof prop === "string" && !prop.startsWith("$") && v !== null && typeof v === "object") return delegate(v, prop);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as PrismaClient;
    return client(prisma);
  }

  const WEEKDAYS_9_17 = (thursdayOpens = "09:00") =>
    [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      weekday <= 5
        ? { weekday, kind: "hours" as const, opensMin: weekday === 4 ? Number(thursdayOpens.slice(0, 2)) * 60 : 540, closesMin: 1020 }
        : { weekday, kind: "closed" as const },
    );

  it("a first hours save committing between a tick's reads: the tick writes nothing of its own (never a false flip-and-back)", async () => {
    await prisma.securitySiteHours.create({ data: { id: "singleton" } });
    await prisma.securityModeState.create({ data: { id: "singleton", setAt: at("2026-09-23", "09:00") } });
    const now = at("2026-09-23", "20:00");
    let fired = false;
    const hooked = instrumented(async (key, _n, phase) => {
      if (key !== "securitySiteHours.findUnique" || phase !== "after" || fired) return;
      fired = true;
      expect(await writeSiteHours(prisma, who(0).req, { state: "set", timezone: TZ, days: WEEKDAYS_9_17() }, 0, now)).toMatchObject({ status: "ok" });
    });
    expect(await tickSecurityMode(hooked, now)).not.toEqual({ outcome: "changed" });
    expect(fired).toBe(true);
    // Only the save's own row: the site closed with the new hours. No bogus "Open (opening hours)".
    const rows = await prisma.securityEvent.findMany({ where: MODE_ROWS, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.dedupeKey, r.labels, r.summary])).toEqual([["site_mode:v1", ["closed", "schedule", "open"], "Closed (opening hours changed)"]]);
    expect(await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } })).toMatchObject({ version: 1, mode: "closed", modeSource: "schedule" });
    expect(await tickSecurityMode(prisma, at("2026-09-23", "20:01"))).toEqual({ outcome: "unchanged" });
  });

  it("a timezone change committing between a Close up's reads: the Close up is re-planned against the NEW zone", async () => {
    await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: "America/New_York", version: 1 } });
    await prisma.securitySchedule.createMany({ data: WEEKDAYS_9_17().map((d) => ({ opensMin: null, closesMin: null, ...d })) });
    await prisma.securityModeState.create({ data: { id: "singleton", setAt: at("2026-09-23", "09:00") } });
    const now = at("2026-09-23", "15:00"); // 10:00 in New York: open under both zones.
    let fired = false;
    const hooked = instrumented(async (key, _n, phase) => {
      if (key !== "securitySiteHours.findUnique" || phase !== "after" || fired) return;
      fired = true;
      expect(await writeSiteHours(prisma, who(1).req, { state: "set", timezone: TZ, days: WEEKDAYS_9_17() }, 1, now)).toMatchObject({ status: "ok" });
    });
    expect(await actOnMode(hooked, who(0), { action: "close" }, now)).toMatchObject({ status: "ok", changed: true });
    expect(fired).toBe(true);
    // Either serial order ends at Thursday 09:00 LONDON — never 09:00 New York (13:00Z).
    expect(await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } })).toMatchObject({
      mode: "closed",
      modeSource: "manual",
      manualEnd: "next_opening",
      manualUntil: at("2026-09-24", "09:00"),
    });
  });

  it("an hours save committing during a Close up's catch-up: the plan uses the NEW hours, not the ones read before it", async () => {
    await seedWeekdays(at("2026-09-22", "17:00"));
    await prisma.securityModeState.update({ where: { id: "singleton" }, data: { mode: "closed" } }); // last night's flip; 09:00 not ticked yet
    const now = at("2026-09-23", "09:00:30");
    let fired = false;
    const hooked = instrumented(async (key, n, phase) => {
      // 1 = the Close up's read, 2 = the catch-up tick's, 3 = the read after the catch-up.
      if (key !== "securityModeState.findUnique" || n !== 3 || phase !== "before") return;
      fired = true;
      expect(await writeSiteHours(prisma, who(1).req, { state: "set", timezone: TZ, days: WEEKDAYS_9_17("07:00") }, 1, now)).toMatchObject({ status: "ok" });
    });
    expect(await actOnMode(hooked, who(0), { action: "close" }, now)).toMatchObject({ status: "ok", changed: true });
    expect(fired).toBe(true);
    expect(await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } })).toMatchObject({
      mode: "closed",
      manualEnd: "next_opening",
      manualUntil: at("2026-09-24", "07:00"),
    });
  });

  it("the mode view never pairs the old zone with new day rows (a zone + days edit committing mid-read)", async () => {
    await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: "America/New_York", version: 1 } });
    await prisma.securitySchedule.createMany({ data: WEEKDAYS_9_17().map((d) => ({ opensMin: null, closesMin: null, ...d })) });
    await prisma.securityModeState.create({ data: { id: "singleton", setAt: at("2026-09-23", "09:00") } });
    const now = at("2026-09-23", "15:00"); // 10:00 in New York
    const closedAllWeek = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, kind: "closed" as const }));
    let fired = false;
    const hooked = instrumented(async (key, _n, phase) => {
      if (key !== "securitySiteHours.findUnique" || phase !== "after" || fired) return;
      fired = true;
      expect(await writeSiteHours(prisma, who(1).req, { state: "set", timezone: TZ, days: closedAllWeek }, 1, now)).toMatchObject({ status: "ok" });
    });
    const view = await readModeView(hooked, now);
    expect(fired).toBe(true);
    const shape = [view.mode, view.hours.state === "set" ? view.hours.timezone : null, view.hours.state === "set" ? view.hours.upcoming : "n/a"];
    // Before the edit: New York, open until 17:00 there. After: London, closed for good. Never New York + closed all week.
    expect([
      JSON.stringify(["open", "America/New_York", { at: "2026-09-23T21:00:00.000Z", mode: "closed" }]),
      JSON.stringify(["closed", TZ, null]),
    ]).toContain(JSON.stringify(shape));
  });

  it("first reads racing on an empty box create the singletons once and never reject", async () => {
    const now = at("2026-09-23", "12:00");
    let rejected = 0;
    for (let round = 0; round < 10; round++) {
      await prisma.securitySiteHours.deleteMany({});
      await prisma.securityModeState.deleteMany({});
      const calls = [
        tickSecurityMode(prisma, now),
        ...Array.from({ length: 4 }, () => readModeView(prisma, now)),
        ...Array.from({ length: 3 }, () => readHoursView(prisma, now, { profileHint: false })),
      ];
      rejected += (await Promise.allSettled(calls)).filter((r) => r.status === "rejected").length;
    }
    expect(rejected).toBe(0);
    expect(await prisma.securitySiteHours.count()).toBe(1);
    expect(await prisma.securityModeState.count()).toBe(1);
  });

  // ── rollback ────────────────────────────────────────────────────────────

  it("a failed audit rolls the change back: no ActivityRow, no feed row, and the chain still verifies", async () => {
    await seedWeekdays();
    const recorder = createActivityRecorder({ prisma, signer });
    await recorder.record({ kind: "system", severity: "info", sourceIcon: "shield", what: `${TAG} seed 1`, actor: { type: "system" } });
    await recorder.record({ kind: "system", severity: "info", sourceIcon: "shield", what: `${TAG} seed 2`, actor: { type: "system" } });

    useRecorder(false);
    await expect(actOnMode(prisma, who(0), { action: "away" }, at("2026-09-23", "12:00"))).rejects.toBeInstanceOf(SecurityAuditUnavailableError);
    await expect(
      writeSiteHours(prisma, who(0).req, { state: "not_set" }, 1, at("2026-09-23", "12:00")),
    ).rejects.toBeInstanceOf(SecurityAuditUnavailableError);

    expect(await prisma.securityModeState.findUniqueOrThrow({ where: { id: "singleton" } })).toMatchObject({ version: 0, mode: "open", modeSource: "schedule" });
    expect(await prisma.securitySiteHours.findUniqueOrThrow({ where: { id: "singleton" } })).toMatchObject({ version: 1, state: "set" });
    expect(await prisma.securitySchedule.count()).toBe(7);
    expect(await prisma.securityEvent.count({ where: MODE_ROWS })).toBe(0);
    expect(await prisma.activityRow.count(mine())).toBe(2);
    expect(await verifyActivityChain(prisma, signer, floor)).toEqual({ ok: true, rowsChecked: 2, brokenAtId: null });

    // The chain continues from the pre-rollback tail.
    useRecorder(true);
    expect(await actOnMode(prisma, who(0), { action: "away" }, at("2026-09-23", "12:00"))).toMatchObject({ status: "ok", changed: true });
    expect(await verifyActivityChain(prisma, signer, floor)).toEqual({ ok: true, rowsChecked: 3, brokenAtId: null });
  });
});
