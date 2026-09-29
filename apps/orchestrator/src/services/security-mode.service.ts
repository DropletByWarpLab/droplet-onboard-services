/**
 * WARP-2977 P2b (ADR-059 §3.6) — the site mode: its data access, the 60 s
 * ticker that follows the opening hours, the `site_mode` health row, and the
 * opening-hours writes (which move the mode with them).
 *
 * Owning slice: A. The signatures other files call are the S0 contract:
 *   · `registerSecurityModeJobs` — index.ts;
 *   · `siteModeHealthState`, `siteModeHealthRow`, `securitySiteModeHealth` —
 *     the /security/health handler (routes/security.ts);
 *   · the wire views `ModeView` / `HoursView` — mirrored in the dashboard's
 *     types.ts.
 * Everything else is called only from routes/security-site.ts and tests.
 *
 * The rules (spec §6.3, §6.7):
 *   · Every write is ONE `READ_COMMITTED_TX` transaction: the CAS on a
 *     `version` column first, then the row changes, then a `mode_changed`
 *     SecurityEvent (only when the MODE differs from the stored row's;
 *     dedupeKey `site_mode:v<newVersion>`), then — for a person — the audit
 *     row LAST (`auditSecurityInTx`). Nothing runs after the audit in the
 *     callback. A lost CAS writes and audits nothing.
 *   · Lock order in every transaction: SecuritySiteHours → SecurityModeState
 *     → SecurityEvent insert → the activity-chain lock.
 *   · Every opening-hours or special-day write ALSO bumps
 *     SecurityModeState.version (under that row's lock), so a tick that read
 *     the old hours loses its CAS instead of writing a mode the new hours no
 *     longer give. That holds only because every reader takes the mode row
 *     and the hours from ONE snapshot (`readModeSnapshot`).
 *   · The ticker is `cronRuntime.scheduleInterval(60_000, tick, {lockKey})` —
 *     never a cron spec (specs fire in process UTC and the wrapper drops
 *     node-cron's timezone option). Level-triggered: after downtime one tick
 *     collapses the missed flips into one row stamped at the last boundary.
 *   · The end of a manual override is audited AFTER its commit, outside the
 *     transaction, through `auditSecuritySystem` (it throws into safeRun's
 *     canary; the expiry itself stands). Schedule flips write no ActivityRow.
 *   · Canary (WARP-2203): no `next…` / `…Cursor` keys in this file — the
 *     words are `upcoming`, `openingAfter`, `changeAfter`, `planned`.
 *
 * Feed rows record changes of the STORED mode: each `mode_changed` row's mode
 * differs from the one before it. So a person's mode change AND every
 * opening-hours or special-day write first catch up a stored row that lags
 * the effective mode (`catchUpLaggingMode`): the missed flip lands at its
 * boundary, an ended override gets its system `mode.expire` audit, and only
 * then does the person's own change (or the mode the new hours give) follow.
 */
import type {
  Prisma,
  PrismaClient,
  SecurityDayKind,
  SecurityHoursState,
  SecurityManualEnd,
  SecurityMode,
  SecurityModeSource,
  SecurityModeState,
  SecuritySchedule,
  SecurityScheduleException,
  SecuritySiteHours,
} from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import { auditSecurityInTx, auditSecuritySystem, stripUnsafeDisplayChars, type SecurityAuditEntry } from "./security-audit.js";
import { READ_COMMITTED_TX, REPEATABLE_READ_TX } from "../lib/prisma-tx.js";
import {
  HOURS_HORIZON_DAYS,
  HOURS_LOOKBACK_DAYS,
  changeAfter,
  dayOnly,
  minutesToHhmm,
  openWindowsBetween,
  openingAfter,
  scheduledModeAt,
  siteClock,
  siteClockCopy,
  siteDayClockCopy,
  weekFrom,
  type DayHours,
  type SiteHours,
  type WeekdayHours,
} from "../lib/security-hours.js";
import {
  effectiveSince,
  fieldsOf,
  isManualExpired,
  modeChangeSummary,
  planModeAction,
  resolveMode,
  sameModeFields,
  type ModeAction,
  type ModeFields,
} from "../lib/security-mode.js";
import { canonicalZone, isValidIanaZone, localPartsOf, ymdAddDays } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-mode");

export const SECURITY_SITE_MODE_INTERVAL_MS = 60_000;
export const SECURITY_SITE_MODE_LOCK_KEY = "droplet:security-site-mode";
/**
 * `scheduleInterval` has no immediate tick, so a freshly registered ticker
 * gets this long before "hasn't checked" reads as down.
 */
export const SECURITY_SITE_MODE_GRACE_MS = 3 * 60_000;
/** Special days a site may have from today on (spec §7 route 14). */
export const SECURITY_EXCEPTION_FUTURE_LIMIT = 100;
/** How far ahead a special day may be set, in site-local days. */
export const SECURITY_EXCEPTION_MAX_DAYS_AHEAD = 366;

const SINGLETON = "singleton";

// ── health ────────────────────────────────────────────────────────────────

export interface SiteModeHealthState {
  /** Set by `registerSecurityModeJobs`. Null = the ticker is not running. */
  registeredAt: Date | null;
  /** The last tick that read the hours and reconciled the mode (changed or not). */
  lastOkAt: Date | null;
  /** The last tick that could not read the hours (invalid zone, ≠ 7 day rows, DB error). */
  lastError: { at: Date; message: string } | null;
}

const modeHealth: SiteModeHealthState = { registeredAt: null, lastOkAt: null, lastError: null };

export function siteModeHealthState(): Readonly<SiteModeHealthState> {
  return modeHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetSiteModeHealthForTests(): void {
  Object.assign(modeHealth, { registeredAt: null, lastOkAt: null, lastError: null } satisfies SiteModeHealthState);
}

/**
 * The opening-hours facts the health row reads. lib/security-hours.ts's
 * `SiteHours` satisfies it structurally.
 */
export type SiteModeHealthHours = { state: "not_set" } | { state: "set"; timezone: string };

/** The stored mode columns. A Prisma `SecurityModeState` row satisfies it. */
export type StoredModeFields = Pick<SecurityModeState, "mode" | "modeSource" | "manualEnd" | "manualUntil">;

/**
 * The `site_mode` row of the /security header (spec §6.7):
 *   · down "Not running" — not registered;
 *   · down "Opening hours can't be read: <reason>" — lastError newer than lastOkAt;
 *   · down "Hasn't checked the opening hours since 5:02 PM" — registered more
 *     than SECURITY_SITE_MODE_GRACE_MS ago and lastOkAt null or older than it
 *     (site-local time; without a site zone, "for N minutes" — never UTC);
 *   · down "Opening hours can't be read" — `hours` / `state` could not be loaded;
 *   · not_configured "No opening hours set, so the site counts as open all the time";
 *   · ok — e.g. "Following opening hours (Europe/London)", "Closed up by hand until 9:00 AM tomorrow".
 * Times are the dashboard's 12-hour, day-aware style (`siteDayClockCopy`):
 * the Sources card shows this copy verbatim beside the mode card's own times.
 * `lastSeenAt` = lastOkAt.
 */
export function siteModeHealthRow(
  health: Readonly<SiteModeHealthState>,
  hours: SiteModeHealthHours | null,
  state: StoredModeFields | null,
  now: Date,
): SecurityHealthRow {
  const lastSeenAt = health.lastOkAt ? health.lastOkAt.toISOString() : null;
  const down = (detail: string): SecurityHealthRow => ({ id: "site_mode", state: "down", detail, lastSeenAt });
  const registeredAt = health.registeredAt;
  if (!registeredAt) return down("Not running");
  const lastOk = health.lastOkAt;
  if (health.lastError && (!lastOk || health.lastError.at.getTime() > lastOk.getTime())) {
    return down(`Opening hours can't be read: ${health.lastError.message}`);
  }
  const tz = hours?.state === "set" && isValidIanaZone(hours.timezone) ? hours.timezone : null;
  const nowMs = now.getTime();
  if (
    nowMs - registeredAt.getTime() > SECURITY_SITE_MODE_GRACE_MS &&
    (!lastOk || nowMs - lastOk.getTime() > SECURITY_SITE_MODE_GRACE_MS)
  ) {
    const since = lastOk ?? registeredAt;
    return down(
      tz
        ? `Hasn't checked the opening hours since ${siteDayClockCopy(since, tz, now)}`
        : `Hasn't checked the opening hours for ${Math.floor((nowMs - since.getTime()) / 60_000)} minutes`,
    );
  }
  if (!hours || !state) return down("Opening hours can't be read");
  if (hours.state === "not_set") {
    return {
      id: "site_mode",
      state: "not_configured",
      detail: "No opening hours set, so the site counts as open all the time",
      lastSeenAt,
    };
  }
  let detail = `Following opening hours (${hours.timezone})`;
  if (state.modeSource === "manual" && !isManualExpired(state, now)) {
    const until = state.manualUntil && tz ? siteDayClockCopy(state.manualUntil, tz, now) : null;
    if (state.mode === "away") detail = "Set to away by hand";
    else if (state.mode === "open") detail = until ? `Opened up by hand until ${until}` : "Opened up by hand";
    else detail = until ? `Closed up by hand until ${until}` : "Closed up by hand until someone changes it";
  }
  return { id: "site_mode", state: "ok", detail, lastSeenAt };
}

/**
 * Load what `siteModeHealthRow` needs and build the row — the one call the
 * /security/health handler makes. Never throws: a read failure is a `down`
 * row, not a 503 of the whole header. Reads only (no singleton upsert).
 */
export async function securitySiteModeHealth(
  prisma: Pick<PrismaClient, "securitySiteHours" | "securityModeState">,
  now: Date,
): Promise<SecurityHealthRow> {
  try {
    const header = await prisma.securitySiteHours.findUnique({ where: { id: SINGLETON } });
    const state = await prisma.securityModeState.findUnique({ where: { id: SINGLETON } });
    const hours: SiteModeHealthHours =
      header && header.state === "set" && header.timezone
        ? { state: "set", timezone: header.timezone }
        : { state: "not_set" };
    // No row yet = the defaults the first write creates (schedule, open).
    const fields: StoredModeFields = state ?? { mode: "open", modeSource: "schedule", manualEnd: "none", manualUntil: null };
    return siteModeHealthRow(modeHealth, hours, fields, now);
  } catch (err) {
    logger.warn({ err }, "site mode health read failed");
    return siteModeHealthRow(modeHealth, null, null, now);
  }
}

// ── reading the hours ─────────────────────────────────────────────────────

/** The delegates the hours readers use — a PrismaClient or a transaction client. */
type HoursDb = Pick<PrismaClient, "securitySchedule" | "securityScheduleException">;

interface HoursRows {
  header: SecuritySiteHours;
  /** The weekday rows as stored (ordered by weekday). */
  days: SecuritySchedule[];
  /** Special days in [site-local today − lookback − 1, today + horizon + 1]. */
  exceptions: SecurityScheduleException[];
  /** Site-local today; null when the hours are not set (or the zone is unknown). */
  today: string | null;
}

export type HoursLoad = HoursRows & ({ ok: true; hours: SiteHours } | { ok: false; reason: string });

function dayFromRow(row: { kind: SecurityDayKind; opensMin: number | null; closesMin: number | null }): DayHours | null {
  if (row.kind !== "hours") return { kind: row.kind };
  if (row.opensMin === null || row.closesMin === null) return null;
  return { kind: "hours", opensMin: row.opensMin, closesMin: row.closesMin };
}

/**
 * Read the weekday rows and the special days the evaluator can reach, and
 * build `SiteHours`. `ok:false` (never a throw) when the stored hours cannot
 * be evaluated — an unknown zone, or not exactly one row per weekday: the
 * ticker then writes nothing and its health row says why. A database error
 * DOES throw.
 */
export async function loadSiteHours(db: HoursDb, header: SecuritySiteHours, now: Date): Promise<HoursLoad> {
  // Sequential on purpose: `db` may be an interactive-transaction client.
  const days = await db.securitySchedule.findMany({ orderBy: { weekday: "asc" } });
  if (header.state === "not_set") {
    return { header, days, exceptions: [], today: null, ok: true, hours: { state: "not_set" } };
  }
  const tz = header.timezone;
  if (!isValidIanaZone(tz)) {
    return { header, days, exceptions: [], today: null, ok: false, reason: `the site timezone ${JSON.stringify(tz)} isn't one Droplet knows` };
  }
  const today = localPartsOf(now, tz).ymd;
  const exceptions = await db.securityScheduleException.findMany({
    where: {
      date: {
        gte: ymdAddDays(today, -(HOURS_LOOKBACK_DAYS + 1)),
        lte: ymdAddDays(today, HOURS_HORIZON_DAYS + 1),
      },
    },
    orderBy: { date: "asc" },
  });
  const rows = { header, days, exceptions, today };
  if (days.map((d) => d.weekday).join(",") !== "1,2,3,4,5,6,7") {
    return { ...rows, ok: false, reason: `expected one row per weekday, found ${days.length}` };
  }
  const week: WeekdayHours[] = [];
  for (const d of days) {
    const day = dayFromRow(d);
    if (!day) return { ...rows, ok: false, reason: `weekday ${d.weekday} has no times` };
    week.push({ weekday: d.weekday, ...day });
  }
  const map = new Map<string, DayHours>();
  for (const e of exceptions) {
    const day = dayFromRow(e);
    if (!day) return { ...rows, ok: false, reason: `the special day ${e.date} has no times` };
    map.set(e.date, day);
  }
  try {
    return { ...rows, ok: true, hours: { state: "set", timezone: tz, week: weekFrom(week), exceptions: map } };
  } catch (err) {
    return { ...rows, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The singletons are created lazily (the defaults satisfy every CHECK). Read
 * first, create only when missing: an upsert on every read would be a write —
 * and a row lock — on every page load and tick, queueing readers behind an
 * hours transaction they do not need to wait for.
 *
 * The create is `INSERT … ON CONFLICT DO NOTHING` (createMany +
 * skipDuplicates) and then a read — never `upsert({update: {}})`: with an
 * empty update Prisma 5 does NOT emit a native upsert, it reads and then
 * inserts, so two first-time callers (the first tick racing the first page
 * load) both insert and the loser throws P2002. Inside a READ COMMITTED
 * transaction DO NOTHING waits for the other inserter and the next statement
 * sees its committed row.
 */
async function ensureHoursHeader(db: Pick<PrismaClient, "securitySiteHours">): Promise<SecuritySiteHours> {
  const row = await db.securitySiteHours.findUnique({ where: { id: SINGLETON } });
  if (row) return row;
  await db.securitySiteHours.createMany({ data: [{ id: SINGLETON }], skipDuplicates: true });
  return db.securitySiteHours.findUniqueOrThrow({ where: { id: SINGLETON } });
}

async function ensureModeState(db: Pick<PrismaClient, "securityModeState">): Promise<SecurityModeState> {
  const row = await db.securityModeState.findUnique({ where: { id: SINGLETON } });
  if (row) return row;
  await db.securityModeState.createMany({ data: [{ id: SINGLETON }], skipDuplicates: true });
  return db.securityModeState.findUniqueOrThrow({ where: { id: SINGLETON } });
}

/** The stored mode row and the hours it is judged against, read in ONE snapshot. */
interface ModeSnapshot {
  stored: SecurityModeState;
  load: HoursLoad;
}

/**
 * The stored mode row, the hours header, the weekday rows and the special
 * days, in ONE REPEATABLE READ snapshot, mode row first. Every hours write
 * bumps SecurityModeState.version in the same commit as the hours, so a plan
 * made from this snapshot either sees an hours edit entirely or loses its CAS
 * to it — never old header + new version + new days, which four separate
 * READ COMMITTED reads allowed (an edit committing between them passed the
 * CAS with a plan built from hours that never existed together). The paths
 * that write nothing (the mode view, a no-op action) get a consistent answer
 * too. A missing singleton is created OUTSIDE the snapshot, then re-read.
 */
async function readModeSnapshot(prisma: PrismaClient, now: Date): Promise<ModeSnapshot> {
  for (let attempt = 0; ; attempt++) {
    const snap = await prisma.$transaction(async (tx) => {
      const stored = await tx.securityModeState.findUnique({ where: { id: SINGLETON } });
      const header = await tx.securitySiteHours.findUnique({ where: { id: SINGLETON } });
      if (!stored || !header) return null;
      return { stored, load: await loadSiteHours(tx, header, now) };
    }, REPEATABLE_READ_TX);
    if (snap) return snap;
    if (attempt > 0) throw new Error("the site mode rows are missing after creating them");
    await ensureModeState(prisma);
    await ensureHoursHeader(prisma);
  }
}

/** The stored hours cannot be evaluated (unknown zone, missing weekday rows). */
export class HoursUnreadableError extends Error {
  constructor(reason: string) {
    super(`opening hours can't be read: ${reason}`);
    this.name = "HoursUnreadableError";
  }
}

// ── the ticker ────────────────────────────────────────────────────────────

export interface SiteModeTickResult {
  outcome: "unchanged" | "changed" | "conflict" | "hours_unreadable";
}

const EXPIRE_WHAT: Readonly<Record<"closed" | "open", string>> = {
  closed: "Security: opening hours took over from a manual Close up",
  open: "Security: opening hours took over from a manual Open up",
};

/**
 * One tick: upsert the singletons, load the week + the special days, resolve
 * the effective mode and, when it differs from the stored row, write it
 * (stamped at the boundary — `effectiveSince`). A lost CAS skips the tick;
 * the next one re-reads. When the write ended a manual override, the system
 * audit row follows AFTER the commit and a failure there THROWS (safeRun's
 * canary) without undoing the expiry.
 *
 * `recordHealth` (default true) — whether this tick counts as the ticker's
 * own check for the site_mode health row (lastOkAt / lastError). Only the
 * registered job's ticks do: a request-path catch-up (`catchUpLaggingMode`)
 * passes false, so a person's action can never make a stalled ticker read
 * "ok", move its "hasn't checked since", or pin a request's read error on it.
 */
export async function tickSecurityMode(
  prisma: PrismaClient,
  now: Date = new Date(),
  opts: { recordHealth?: boolean } = {},
): Promise<SiteModeTickResult> {
  const recordHealth = opts.recordHealth ?? true;
  let stored: SecurityModeState;
  let load: HoursLoad;
  try {
    ({ stored, load } = await readModeSnapshot(prisma, now));
  } catch (err) {
    if (recordHealth) modeHealth.lastError = { at: now, message: "the database couldn't be read" };
    throw err;
  }
  if (!load.ok) {
    if (recordHealth) modeHealth.lastError = { at: now, message: load.reason };
    return { outcome: "hours_unreadable" };
  }
  const planned = fieldsOf(resolveMode(stored, load.hours, now));
  if (sameModeFields(planned, stored)) {
    if (recordHealth) modeHealth.lastOkAt = now;
    return { outcome: "unchanged" };
  }
  const expiry = isManualExpired(stored, now);
  const tz = load.hours.state === "set" ? load.hours.timezone : null;
  const result = await applyModeChange(prisma, {
    plan: { current: stored, next: planned },
    actor: { type: "system" },
    startedAt: effectiveSince(stored, load.hours, now),
    summary: modeChangeSummary(planned, { type: "schedule" }, tz),
    audit: null,
  });
  if (result.status === "conflict") return { outcome: "conflict" };
  if (recordHealth) modeHealth.lastOkAt = now;
  if (result.modeChangedRow) {
    logger.info({ mode: planned.mode, version: result.state.version }, "site mode followed the opening hours");
  }
  if (expiry && stored.manualUntil && (stored.mode === "closed" || stored.mode === "open")) {
    // After the commit, never inside it: a broken chain must not keep an
    // override alive. Throws into safeRun; the expiry above already stands.
    await auditSecuritySystem({
      action: "mode.expire",
      what: EXPIRE_WHAT[stored.mode],
      refs: {
        endedMode: stored.mode,
        endedManualEnd: stored.manualEnd,
        endedAt: stored.manualUntil.toISOString(),
        setById: stored.setById,
        mode: planned.mode,
        version: result.state.version,
      },
    });
  }
  return { outcome: "changed" };
}

/**
 * Register the site-mode ticker on the cron runtime, single-flighted on
 * SECURITY_SITE_MODE_LOCK_KEY, and set `registeredAt`. Registered
 * unconditionally, like the P2a jobs: the module toggle decides the surface,
 * not the bookkeeping.
 */
export function registerSecurityModeJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
): void {
  cronRuntime.scheduleInterval(
    SECURITY_SITE_MODE_INTERVAL_MS,
    async () => {
      const r = await tickSecurityMode(prisma);
      if (r.outcome === "hours_unreadable") {
        logger.warn({ reason: modeHealth.lastError?.message }, "site mode tick: opening hours unreadable");
      }
    },
    { lockKey: SECURITY_SITE_MODE_LOCK_KEY },
  );
  modeHealth.registeredAt = new Date();
}

// ── mode writes ───────────────────────────────────────────────────────────

/** Who changed the mode. `name` feeds the feed row's summary ("Closed up by Maria"). */
export type ModeActor = { type: "user"; id: string; name: string } | { type: "system" };

export interface ModeChangePlan {
  /** The row the plan was made from — its `version` is the CAS expectation; its `mode` decides the feed row. */
  current: SecurityModeState;
  next: StoredModeFields;
}

export interface ApplyModeChangeInput {
  plan: ModeChangePlan;
  actor: ModeActor;
  /** The mode_changed row's startedAt, and the new setAt (the boundary for a schedule flip, manualUntil for an expiry, now for a person). */
  startedAt: Date;
  /** The mode_changed row's summary (`modeChangeSummary`). */
  summary: string;
  /**
   * Human routes: the audit written IN the transaction, last. The ticker
   * passes null and audits an expiry after commit.
   */
  audit: { req: { user?: { id: string; role?: string } | undefined }; entry: SecurityAuditEntry } | null;
}

export type ApplyModeChangeResult =
  | { status: "applied"; state: SecurityModeState; modeChangedRow: boolean }
  /** The CAS matched no row: someone else moved it first. Nothing was written. */
  | { status: "conflict" };

/**
 * A `mode_changed` feed row inside the caller's transaction. labels =
 * [mode, modeSource, fromMode] (the CHECK pins the shape): the FROM mode on
 * every row is what makes the rows P3's complete mode history — the mode at
 * t is the latest row at or before t, else the earliest row after t's
 * fromMode (so a trimmed row, or a time before the first row, still has an
 * answer), else the current mode (no change in the window).
 */
async function insertModeChangedRow(
  tx: Pick<PrismaClient, "securityEvent">,
  input: { version: number; fields: ModeFields; from: SecurityMode; startedAt: Date; summary: string },
): Promise<boolean> {
  const { count } = await tx.securityEvent.createMany({
    data: [
      {
        source: "site_mode",
        kind: "mode_changed",
        severity: "info",
        camera: null,
        sourceRef: "site",
        dedupeKey: `site_mode:v${input.version}`,
        labels: [input.fields.mode, input.fields.modeSource, input.from],
        cameraZones: [],
        score: null,
        startedAt: input.startedAt,
        endedAt: null,
        summary: input.summary,
      },
    ],
    // A version is written once — but a re-created singleton restarts at 0,
    // and a leftover row from before must never block every mode change.
    skipDuplicates: true,
  });
  return count > 0;
}

/**
 * One READ_COMMITTED_TX transaction: CAS on the version → a mode_changed row
 * when the MODE differs from the stored one → the audit (people only), last.
 */
export async function applyModeChange(prisma: PrismaClient, input: ApplyModeChangeInput): Promise<ApplyModeChangeResult> {
  const { current, next: planned } = input.plan;
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.securityModeState.updateMany({
      where: { id: SINGLETON, version: current.version },
      data: {
        mode: planned.mode,
        modeSource: planned.modeSource,
        manualEnd: planned.manualEnd,
        manualUntil: planned.manualUntil,
        version: { increment: 1 },
        setAt: input.startedAt,
        setById: input.actor.type === "user" ? input.actor.id : null,
      },
    });
    if (count !== 1) return { status: "conflict" } as const;
    const state = await tx.securityModeState.findUniqueOrThrow({ where: { id: SINGLETON } });
    const modeChangedRow =
      planned.mode !== current.mode
        ? await insertModeChangedRow(tx, { version: state.version, fields: planned, from: current.mode, startedAt: input.startedAt, summary: input.summary })
        : false;
    // LAST. Nothing may follow it in this callback (it holds the chain lock until commit).
    if (input.audit) await auditSecurityInTx(tx, input.audit.req, input.audit.entry);
    return { status: "applied", state, modeChangedRow } as const;
  }, READ_COMMITTED_TX);
}

/** The person acting. */
export interface ModeRequester {
  req: { user?: { id: string; role?: string } | undefined };
  id: string;
  /** Display name for the feed row, already made safe (`summaryName`). */
  name: string;
}

export type ModeActionResult = { status: "ok"; mode: ModeView; changed: boolean } | { status: "conflict" };

const ACTION_AUDIT: Readonly<Record<ModeAction["action"], SecurityAuditEntry["action"]>> = {
  close: "mode.close",
  open: "mode.open",
  away: "mode.away",
  resume: "mode.resume",
};

function modeActionWhat(planned: ModeFields, action: ModeAction, tz: string | null): string {
  if (planned.modeSource === "schedule") {
    return action.action === "close" ? "Security: closed up (the opening hours already have it closed)" : "Security: back to opening hours";
  }
  if (planned.mode === "away") return "Security: set to away";
  if (planned.mode === "open") {
    return planned.manualUntil && tz ? `Security: opened up until ${siteClock(planned.manualUntil, tz)}` : "Security: opened up";
  }
  return "Security: closed up";
}

/**
 * Before a person's mode change or opening-hours write: when the stored row
 * lags the effective mode (a schedule flip or the end of an override that the
 * ticker has not written yet — one interval after a boundary, or longer when
 * the ticker lags), write that change first, exactly as the ticker would: a
 * feed row stamped at the boundary and, when an override ended, the system
 * `mode.expire` audit after its commit. Without it the change is compared
 * against the stale stored mode, so "Closed up by Maria" at 09:00:30 (stored
 * still "closed" from last night) would write no feed row at all, an Open up
 * that ended at 19:00 would never be audited as ended, and an hours edit
 * would stamp the missed flip at the edit, as "opening hours changed", and
 * pin the end of someone's override on the editor.
 *
 * Best effort, and never inside the person's transaction (the tick's system
 * audit takes the chain lock on the global client). A lost race or a failed
 * system audit is logged and the person's change goes ahead; the tick's own
 * expiry, if it landed, is already committed. It is not the ticker's own
 * check, so it leaves the site_mode health row alone (`recordHealth: false`).
 */
async function catchUpLaggingMode(prisma: PrismaClient, now: Date): Promise<void> {
  try {
    await tickSecurityMode(prisma, now, { recordHealth: false });
  } catch (err) {
    logger.warn({ err }, "site mode: catching up before a person's change failed; their change goes ahead");
  }
}

/**
 * Route 7: apply a person's intent to the CURRENT state. Server-side CAS with
 * one re-read-and-re-plan on a lost race, then `conflict` (409). A no-op is
 * `changed:false` with nothing written and nothing audited. A stored row
 * that lags the effective mode is caught up first (`catchUpLaggingMode`).
 * Throws `HoursUnreadableError` when the hours cannot be evaluated.
 */
export async function actOnMode(
  prisma: PrismaClient,
  who: ModeRequester,
  action: ModeAction,
  now: Date,
): Promise<ModeActionResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let { stored, load } = await readModeSnapshot(prisma, now);
    if (!load.ok) throw new HoursUnreadableError(load.reason);
    if (!sameModeFields(fieldsOf(resolveMode(stored, load.hours, now)), stored)) {
      await catchUpLaggingMode(prisma, now);
      // Re-read the mode AND the hours: an hours edit may have committed
      // during the catch-up, and the CAS version must come from the same
      // snapshot as the hours the plan is made from.
      ({ stored, load } = await readModeSnapshot(prisma, now));
      if (!load.ok) throw new HoursUnreadableError(load.reason);
    }
    const plan = planModeAction(stored, load.hours, action, now);
    if (!plan.changed) {
      return { status: "ok", changed: false, mode: await buildModeView(prisma, stored, load.hours, now) };
    }
    const tz = load.hours.state === "set" ? load.hours.timezone : null;
    const result = await applyModeChange(prisma, {
      plan: { current: stored, next: plan.next },
      actor: { type: "user", id: who.id, name: who.name },
      startedAt: now,
      summary: modeChangeSummary(plan.next, { type: "user", name: who.name }, tz),
      audit: {
        req: who.req,
        entry: {
          action: ACTION_AUDIT[action.action],
          what: modeActionWhat(plan.next, action, tz),
          refs: {
            from: plan.effective.mode,
            fromSource: plan.effective.source,
            mode: plan.next.mode,
            source: plan.next.modeSource,
            manualEnd: plan.next.manualEnd,
            until: plan.next.manualUntil ? plan.next.manualUntil.toISOString() : null,
            ...(action.action === "open" ? { for: action.for } : {}),
          },
        },
      },
    });
    if (result.status === "applied") {
      return { status: "ok", changed: true, mode: await buildModeView(prisma, result.state, load.hours, now, who) };
    }
  }
  return { status: "conflict" };
}

// ── opening-hours writes (routes 13–15) ───────────────────────────────────

/** What an hours write did to the mode — `refs.modeEffect` on its audit row. */
export type ModeEffect = "unchanged" | "until_moved" | "until_changed" | "override_ended" | "mode_changed";

function modeEffectOf(from: ModeFields, to: ModeFields): ModeEffect {
  if (to.mode !== from.mode) return "mode_changed";
  if (to.modeSource !== from.modeSource) return "override_ended";
  if (to.manualEnd !== from.manualEnd) return "until_changed";
  if (!sameModeFields(to, from)) return "until_moved";
  return "unchanged";
}

type ModeTx = Pick<PrismaClient, "securityModeState" | "securityEvent">;

/**
 * Inside an hours transaction, AFTER the SecuritySiteHours CAS: lock and bump
 * SecurityModeState.version (ALWAYS — a tick that read the old hours must lose
 * its CAS), then move the mode with the new hours:
 *   · a manual Close up (`next_opening`) re-aims at the new hours' next
 *     opening, or holds until someone changes it when there is none;
 *   · Open up (`at_time`) and until-changed modes are kept;
 *   · a schedule-following mode takes the new hours' mode, with a feed row
 *     when that changes the mode.
 * "Current" is the EFFECTIVE mode under the OLD hours, so an override that
 * had already ended is not revived by the edit.
 */
async function moveModeWithHours(
  tx: ModeTx,
  oldHours: SiteHours | null,
  newHours: SiteHours,
  now: Date,
): Promise<{ effect: ModeEffect; state: SecurityModeState }> {
  // Upsert-with-increment: creates the singleton if needed, else takes its
  // row lock and bumps the version, in one statement.
  const locked = await tx.securityModeState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, version: 1 },
    update: { version: { increment: 1 } },
  });
  const before: ModeFields = oldHours ? fieldsOf(resolveMode(locked, oldHours, now)) : locked;
  let planned: ModeFields = before;
  if (before.modeSource === "manual" && before.manualEnd === "next_opening") {
    const opening = openingAfter(newHours, now);
    planned = opening
      ? { ...before, manualUntil: opening }
      : { mode: "closed", modeSource: "manual", manualEnd: "until_changed", manualUntil: null };
  } else if (before.modeSource === "schedule") {
    planned = { mode: scheduledModeAt(newHours, now), modeSource: "schedule", manualEnd: "none", manualUntil: null };
  }
  const effect = modeEffectOf(locked, planned);
  if (effect === "unchanged") return { effect, state: locked };
  // The same override, re-aimed: it keeps who set it and when.
  const sameOverride = effect === "until_moved" || effect === "until_changed";
  const state = await tx.securityModeState.update({
    where: { id: SINGLETON },
    data: {
      mode: planned.mode,
      modeSource: planned.modeSource,
      manualEnd: planned.manualEnd,
      manualUntil: planned.manualUntil,
      ...(sameOverride ? {} : { setAt: now, setById: planned.modeSource === "schedule" ? null : locked.setById }),
    },
  });
  if (effect === "mode_changed") {
    await insertModeChangedRow(tx, {
      version: state.version,
      fields: planned,
      from: locked.mode,
      startedAt: now,
      summary: modeChangeSummary(planned, { type: "hours_changed" }, null),
    });
  }
  return { effect, state };
}

export type HoursInput =
  | { state: "set"; timezone: string; days: WeekdayHours[] }
  | { state: "not_set" };

export type HoursWriteResult =
  | { status: "ok"; effect: ModeEffect }
  | { status: "version_conflict" }
  | { status: "hours_not_set" }
  | { status: "out_of_range" }
  | { status: "exception_limit" }
  | { status: "not_found" };

/** Thrown inside a transaction to roll back a CAS that already landed. */
class HoursRollback extends Error {
  constructor(readonly result: Exclude<HoursWriteResult, { status: "ok" }>) {
    super(`hours write rolled back: ${result.status}`);
    this.name = "HoursRollback";
  }
}

async function runHoursTx(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<HoursWriteResult>,
): Promise<HoursWriteResult> {
  try {
    return await prisma.$transaction((tx) => fn(tx), READ_COMMITTED_TX);
  } catch (err) {
    if (err instanceof HoursRollback) return err.result;
    throw err;
  }
}

function hhmm(min: number | null): string | null {
  return min === null ? null : minutesToHhmm(min);
}

function dayRefs(d: DayHours): { kind: SecurityDayKind; opens: string | null; closes: string | null } {
  return d.kind === "hours"
    ? { kind: "hours", opens: minutesToHhmm(d.opensMin), closes: minutesToHhmm(d.closesMin) }
    : { kind: d.kind, opens: null, closes: null };
}

function dayColumns(d: DayHours): { kind: SecurityDayKind; opensMin: number | null; closesMin: number | null } {
  return d.kind === "hours"
    ? { kind: "hours", opensMin: d.opensMin, closesMin: d.closesMin }
    : { kind: d.kind, opensMin: null, closesMin: null };
}

/**
 * Route 13. `input` is validated by the route (7 unique weekdays, valid
 * minutes, a canonical zone). CAS on SecuritySiteHours.version, replace the
 * week (and, for not_set, every special day), move the mode, audit last.
 */
export async function writeSiteHours(
  prisma: PrismaClient,
  req: ModeRequester["req"],
  input: HoursInput,
  expectedVersion: number,
  now: Date,
): Promise<HoursWriteResult> {
  await catchUpLaggingMode(prisma, now);
  return runHoursTx(prisma, async (tx) => {
    const header = await ensureHoursHeader(tx);
    const { count } = await tx.securitySiteHours.updateMany({
      where: { id: SINGLETON, version: expectedVersion },
      data: {
        state: input.state,
        timezone: input.state === "set" ? input.timezone : null,
        version: { increment: 1 },
        updatedById: req.user?.id ?? null,
      },
    });
    if (count !== 1) return { status: "version_conflict" };
    const old = await loadSiteHours(tx, header, now);
    await tx.securitySchedule.deleteMany({});
    let fresh: SiteHours = { state: "not_set" };
    if (input.state === "set") {
      await tx.securitySchedule.createMany({
        data: input.days.map((d) => ({ weekday: d.weekday, ...dayColumns(dayOnly(d)) })),
      });
      const reload = await loadSiteHours(tx, { ...header, state: "set", timezone: input.timezone }, now);
      if (!reload.ok) throw new HoursUnreadableError(reload.reason);
      fresh = reload.hours;
    } else {
      await tx.securityScheduleException.deleteMany({});
    }
    const { effect } = await moveModeWithHours(tx, old.ok ? old.hours : null, fresh, now);
    await auditSecurityInTx(tx, req, {
      action: input.state === "set" ? "hours.set" : "hours.clear",
      what: input.state === "set" ? "Security: opening hours changed" : "Security: opening hours cleared",
      refs:
        input.state === "set"
          ? {
              timezone: input.timezone,
              days: [...input.days].sort((a, b) => a.weekday - b.weekday).map((d) => ({ weekday: d.weekday, ...dayRefs(d) })),
              modeEffect: effect,
            }
          : { modeEffect: effect },
    });
    return { status: "ok", effect };
  });
}

/**
 * Route 14: add or replace one special day. `hours_not_set` before anything
 * else (a special day needs the site zone), `out_of_range` outside
 * [site-local today−1, today+366], then the CAS, then the 100-future limit
 * under the header's row lock (two concurrent adds cannot both squeeze in).
 */
export async function writeHoursException(
  prisma: PrismaClient,
  req: ModeRequester["req"],
  input: { date: string; day: DayHours; note: string },
  expectedVersion: number,
  now: Date,
): Promise<HoursWriteResult> {
  await catchUpLaggingMode(prisma, now);
  return runHoursTx(prisma, async (tx) => {
    const header = await ensureHoursHeader(tx);
    if (header.state !== "set") return { status: "hours_not_set" };
    if (!isValidIanaZone(header.timezone)) {
      throw new HoursUnreadableError(`unknown site timezone ${JSON.stringify(header.timezone)}`);
    }
    const today = localPartsOf(now, header.timezone).ymd;
    if (input.date < ymdAddDays(today, -1) || input.date > ymdAddDays(today, SECURITY_EXCEPTION_MAX_DAYS_AHEAD)) {
      return { status: "out_of_range" };
    }
    const { count } = await tx.securitySiteHours.updateMany({
      where: { id: SINGLETON, version: expectedVersion, state: "set" },
      data: { version: { increment: 1 }, updatedById: req.user?.id ?? null },
    });
    if (count !== 1) return { status: "version_conflict" };
    const old = await loadSiteHours(tx, header, now);
    const existing = await tx.securityScheduleException.findUnique({ where: { date: input.date } });
    if (!existing && input.date >= today) {
      const upcoming = await tx.securityScheduleException.count({ where: { date: { gte: today } } });
      if (upcoming >= SECURITY_EXCEPTION_FUTURE_LIMIT) throw new HoursRollback({ status: "exception_limit" });
    }
    const columns = dayColumns(input.day);
    await tx.securityScheduleException.upsert({
      where: { date: input.date },
      create: { date: input.date, ...columns, note: input.note, createdById: req.user?.id ?? null },
      update: { ...columns, note: input.note },
    });
    const reload = await loadSiteHours(tx, header, now);
    if (!reload.ok) throw new HoursUnreadableError(reload.reason);
    const { effect } = await moveModeWithHours(tx, old.ok ? old.hours : null, reload.hours, now);
    await auditSecurityInTx(tx, req, {
      action: "exception.set",
      what: `Security: special day ${input.date} set`,
      refs: { date: input.date, ...dayRefs(input.day), note: input.note, replaced: existing !== null, modeEffect: effect },
    });
    return { status: "ok", effect };
  });
}

/** Route 15: remove one special day. CAS on the hours version; `not_found` rolls the CAS back. */
export async function deleteHoursException(
  prisma: PrismaClient,
  req: ModeRequester["req"],
  date: string,
  expectedVersion: number,
  now: Date,
): Promise<HoursWriteResult> {
  await catchUpLaggingMode(prisma, now);
  return runHoursTx(prisma, async (tx) => {
    const header = await ensureHoursHeader(tx);
    const { count } = await tx.securitySiteHours.updateMany({
      where: { id: SINGLETON, version: expectedVersion },
      data: { version: { increment: 1 }, updatedById: req.user?.id ?? null },
    });
    if (count !== 1) return { status: "version_conflict" };
    const old = await loadSiteHours(tx, header, now);
    const removed = await tx.securityScheduleException.deleteMany({ where: { date } });
    if (removed.count !== 1) throw new HoursRollback({ status: "not_found" });
    const reload = await loadSiteHours(tx, header, now);
    if (!reload.ok) throw new HoursUnreadableError(reload.reason);
    const { effect } = await moveModeWithHours(tx, old.ok ? old.hours : null, reload.hours, now);
    await auditSecurityInTx(tx, req, {
      action: "exception.delete",
      what: `Security: special day ${date} removed`,
      refs: { date, modeEffect: effect },
    });
    return { status: "ok", effect };
  });
}

// ── wire views (routes 5, 6, 7, 13) — mirrored in apps/web-dashboard/src/lib/types.ts ──

export interface ModeView {
  /** The EFFECTIVE mode (`resolveMode`), never the raw stored one. */
  mode: SecurityMode;
  source: SecurityModeSource;
  manualEnd: SecurityManualEnd;
  /** ISO instant a manual mode ends (next_opening / at_time); null otherwise. */
  until: string | null;
  setBy: { id: string; name: string } | null;
  setAt: string;
  hours:
    | { state: "not_set" }
    | {
        state: "set";
        timezone: string;
        scheduledMode: "open" | "closed";
        upcoming: { at: string; mode: "open" | "closed" } | null;
      };
  /**
   * The zone the dashboard formats every time on the mode card in: the SITE
   * timezone when the hours are set; else Workspace.tz when `isValidIanaZone`
   * accepts it (the same rule as HoursView.hint.workspaceTimezone); else null,
   * and the dashboard falls back to the device's zone. Never "UTC" as a
   * stand-in for "unknown".
   */
  displayTimezone: string | null;
  /**
   * The site_mode health row is down, or the stored row has lagged the
   * effective mode for LONGER than SECURITY_SITE_MODE_GRACE_MS (see
   * `modeViewStale`). Never true merely because a boundary or an expiry
   * passed less than one grace ago: the mode shown is right, the ticker just
   * has not written it down yet.
   */
  stale: boolean;
  version: number;
}

export interface HoursDayView {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  kind: SecurityDayKind;
  /** 'HH:MM' site-local; null unless kind = hours. */
  opens: string | null;
  closes: string | null;
}

export interface HoursExceptionView {
  /** Site-local 'YYYY-MM-DD'. */
  date: string;
  kind: SecurityDayKind;
  opens: string | null;
  closes: string | null;
  note: string;
}

export interface HoursView {
  state: SecurityHoursState;
  timezone: string | null;
  version: number;
  /** 7 entries, Monday first; all `closed` while not_set. */
  days: HoursDayView[];
  /**
   * date ≥ site-local today−1: at most the 100 from today on (the write limit)
   * plus yesterday's — every special day a person can still see and remove.
   */
  exceptions: HoursExceptionView[];
  /** The open windows in [now, now + 7 days), clipped to it; [] while not_set. */
  preview: Array<{ startsAt: string; endsAt: string }>;
  /** typicalDay is "" unless the reader may see the business profile's structured fields (owner/admin, §15). */
  hint: { workspaceTimezone: string | null; typicalDay: string };
}

/** The workspace's timezone, only when it is a zone the runtime knows (canonical spelling); else null. Never UTC. */
async function workspaceTimezone(prisma: Pick<PrismaClient, "workspace">): Promise<string | null> {
  const ws = await prisma.workspace.findUnique({ where: { id: 1 }, select: { tz: true } });
  return ws?.tz && isValidIanaZone(ws.tz) ? canonicalZone(ws.tz) : null;
}

/**
 * WARP-2980 (P5 §6.2, D20) — THE display-zone rule, in one place: the site
 * zone when the opening hours are set; else Workspace.tz when
 * `isValidIanaZone` accepts it (canonical spelling); else null. Never "UTC"
 * as a stand-in for "unknown".
 *
 * Used by the mode card (`ModeView.displayTimezone`) and by the baselines,
 * which cut their hour slots in this zone — so a household with no opening
 * hours still learns, in the workspace's zone. When the hours are set but
 * their zone is one the runtime cannot read, the answer is null: the site's
 * declared zone is never silently swapped for another one.
 *
 * `known` — the hours header a caller already read in its own snapshot (the
 * mode view); the header is then not read again.
 */
export async function resolveSecurityTimezone(
  prisma: Pick<PrismaClient, "securitySiteHours" | "workspace">,
  known?: SiteModeHealthHours,
): Promise<string | null> {
  let hours: SiteModeHealthHours;
  if (known) {
    hours = known;
  } else {
    const header = await prisma.securitySiteHours.findUnique({ where: { id: SINGLETON } });
    hours = header && header.state === "set" && header.timezone ? { state: "set", timezone: header.timezone } : { state: "not_set" };
  }
  if (hours.state === "set") return isValidIanaZone(hours.timezone) ? hours.timezone : null;
  return workspaceTimezone(prisma);
}

/**
 * A person's name as a feed summary can carry it: none of the characters
 * `stripUnsafeDisplayChars` removes (controls, line separators, bidi
 * overrides and isolates — the name is a self-edited Nextcloud display name,
 * and it lands in an append-only feed row every Security viewer reads), no
 * lone surrogates, ≤ 60 chars, never empty.
 */
export function summaryName(raw: string | null | undefined): string {
  const cleaned = stripUnsafeDisplayChars(raw ?? "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .trim()
    .slice(0, 60)
    // A cut can split a surrogate pair.
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "someone";
}

async function buildModeView(
  prisma: PrismaClient,
  state: SecurityModeState,
  hours: SiteHours,
  now: Date,
  knownSetter?: { id: string; name: string },
): Promise<ModeView> {
  const effective = resolveMode(state, hours, now);
  let setBy: ModeView["setBy"] = null;
  if (effective.source === "manual" && state.setById) {
    if (knownSetter && knownSetter.id === state.setById) {
      setBy = { id: knownSetter.id, name: knownSetter.name };
    } else {
      const user = await prisma.user.findUnique({
        where: { id: state.setById },
        select: { displayName: true, username: true },
      });
      setBy = { id: state.setById, name: summaryName(user ? user.displayName || user.username : null) };
    }
  }
  const upcoming = changeAfter(hours, now);
  const health = siteModeHealthRow(modeHealth, hours, state, now);
  return {
    mode: effective.mode,
    source: effective.source,
    manualEnd: effective.manualEnd,
    until: effective.manualUntil ? effective.manualUntil.toISOString() : null,
    setBy,
    setAt: effectiveSince(state, hours, now).toISOString(),
    hours:
      hours.state === "set"
        ? {
            state: "set",
            timezone: hours.timezone,
            scheduledMode: scheduledModeAt(hours, now),
            upcoming: upcoming ? { at: upcoming.at.toISOString(), mode: upcoming.to } : null,
          }
        : { state: "not_set" },
    displayTimezone: await resolveSecurityTimezone(
      prisma,
      hours.state === "set" ? { state: "set", timezone: hours.timezone } : { state: "not_set" },
    ),
    stale: modeViewStale(state, hours, health, now),
    version: state.version,
  };
}

/**
 * `ModeView.stale` — whether the mode card warns that the mode "may be out
 * of date":
 *   · the site_mode health row is down (the ticker is not running, cannot
 *     read the hours, or has not checked for longer than the grace); or
 *   · the stored row has lagged the effective mode for LONGER than
 *     SECURITY_SITE_MODE_GRACE_MS, counted from the moment they parted
 *     (`effectiveSince`: the boundary, or the end of the override) — e.g.
 *     just after a restart, inside the health row's own start-up grace,
 *     with a row that still says last night's mode.
 * A shorter lag is the ticker's ordinary ≤ 60 s delay after every boundary
 * and every expiry. The view already shows the EFFECTIVE mode then, so a
 * warning would be wrong on every single flip. Same grace as the health row.
 */
export function modeViewStale(
  state: StoredModeFields & { setAt: Date },
  hours: SiteHours,
  health: Pick<SecurityHealthRow, "state">,
  now: Date,
): boolean {
  if (health.state === "down") return true;
  if (sameModeFields(fieldsOf(resolveMode(state, hours, now)), state)) return false;
  return now.getTime() - effectiveSince(state, hours, now).getTime() > SECURITY_SITE_MODE_GRACE_MS;
}

/** Route 5. Throws when the state or the hours cannot be read — the route answers 503 MODE_UNAVAILABLE, never a fake "open". */
export async function readModeView(prisma: PrismaClient, now: Date): Promise<ModeView> {
  const { stored, load } = await readModeSnapshot(prisma, now);
  if (!load.ok) throw new HoursUnreadableError(load.reason);
  return buildModeView(prisma, stored, load.hours, now);
}

/**
 * WARP-2979 (P4 §6.12.3) — the site's clock for the chat tools' periods: the
 * hours the evaluator reads and the display zone (`resolveSecurityTimezone`),
 * from ONE snapshot. Throws `HoursUnreadableError` when the stored hours
 * cannot be evaluated (the caller then knows no zone), and on a read error.
 */
export async function readSiteClock(prisma: PrismaClient, now: Date): Promise<{ hours: SiteHours; timezone: string | null }> {
  const { load } = await readModeSnapshot(prisma, now);
  if (!load.ok) throw new HoursUnreadableError(load.reason);
  const hours = load.hours;
  const timezone = await resolveSecurityTimezone(prisma, hours.state === "set" ? { state: "set", timezone: hours.timezone } : { state: "not_set" });
  return { hours, timezone };
}

const WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Route 6. Throws when the site zone is unknown — the route answers 503.
 * Missing weekday rows read as closed (the ticker's health row reports them).
 *
 * `profileHint` — whether the reader may see the business profile's
 * typicalDay. The caller decides with the business profile's own audience
 * ladder (`businessViewForRole(role) === "full"`: owner/admin): a family
 * member gets the profile's summary only, never its structured fields, so
 * here they get "" and the profile is not even read.
 */
export async function readHoursView(prisma: PrismaClient, now: Date, opts: { profileHint: boolean }): Promise<HoursView> {
  const header = await ensureHoursHeader(prisma);
  if (header.state === "set" && !isValidIanaZone(header.timezone)) {
    throw new HoursUnreadableError(`unknown site timezone ${JSON.stringify(header.timezone)}`);
  }
  const load = await loadSiteHours(prisma, header, now);
  const byWeekday = new Map(load.days.map((d) => [d.weekday, d] as const));
  const days: HoursDayView[] = WEEK.map((weekday) => {
    const row = header.state === "set" ? byWeekday.get(weekday) : undefined;
    return row
      ? { weekday, kind: row.kind, opens: hhmm(row.opensMin), closes: hhmm(row.closesMin) }
      : { weekday, kind: "closed", opens: null, closes: null };
  });
  const fromDate = load.today ? ymdAddDays(load.today, -1) : null;
  const exceptions: HoursExceptionView[] = fromDate
    ? load.exceptions
        .filter((e) => e.date >= fromDate)
        // The limit counts today on; yesterday's rides on top, so a full year
        // still shows its furthest day (never cut off where nobody can remove it).
        .slice(0, SECURITY_EXCEPTION_FUTURE_LIMIT + 1)
        .map((e) => ({ date: e.date, kind: e.kind, opens: hhmm(e.opensMin), closes: hhmm(e.closesMin), note: e.note }))
    : [];
  const preview =
    load.ok && load.hours.state === "set"
      ? openWindowsBetween(load.hours, now, new Date(now.getTime() + 7 * 86_400_000)).map((w) => ({
          startsAt: w.start.toISOString(),
          endsAt: w.end.toISOString(),
        }))
      : [];
  const profile = opts.profileHint
    ? await prisma.businessProfile.findUnique({ where: { id: SINGLETON }, select: { typicalDay: true } })
    : null;
  return {
    state: header.state,
    timezone: header.state === "set" ? header.timezone : null,
    version: header.version,
    days,
    exceptions,
    preview,
    hint: { workspaceTimezone: await workspaceTimezone(prisma), typicalDay: profile?.typicalDay ?? "" },
  };
}
