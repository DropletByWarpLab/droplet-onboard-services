/**
 * WARP-2977 P2b (ADR-059 §3.6) — the site mode and the opening hours.
 *
 * Mounted at "/api" in app.ts beside createSecurityRouter, under the
 * `security` module gate that mountModuleGates mounts off /api/security
 * (box toggle + per-person view). Spec §7:
 *
 *    5  GET    /api/security/mode                          view
 *    6  GET    /api/security/hours                         view
 *    7  POST   /api/security/mode                          act
 *   13  PUT    /api/security/hours                         manage
 *   14  PUT    /api/security/hours/exceptions/:date        manage
 *   15  DELETE /api/security/hours/exceptions/:date        manage
 *
 * Gating: every GET is `requireRole('owner','admin','family')` ONLY — a page
 * load can never produce a feature-gate denial (which the P2a threat mirror
 * would copy into the feed as a threat). The act route is
 * `sensitiveRateLimit, requireRole('owner','admin','family'),
 * requireFeatureAccess('security','act')`; manage routes are
 * `sensitiveRateLimit, requireRole('owner','admin'),
 * requireFeatureAccess('security','manage')`. Never `requireRoleOrMcpService`.
 *
 * Errors are `{error: {code, message, issues?}}`. Mode actions are intents
 * applied to the current state (server CAS + one retry, then 409
 * MODE_CONFLICT); hours and special-day writes carry `expectedVersion` (409
 * VERSION_CONFLICT). An audit failure is 503 AUDIT_UNAVAILABLE with nothing
 * changed — every 5xx here means nothing changed; an hours write that
 * committed but cannot be read back answers 200 `{hours: null, mode: null}`.
 * User text is checked with `chainSafeText` BEFORE the transaction.
 *
 * WARP-2977 P2b-2 — a Close up or Away answer carries `unlockedLocks`: the
 * names of the door locks last heard open (DS-019: only for someone who may
 * read locks; for anyone else the field is absent). It never says "all
 * locked" — a lock that is locked, unknown, never heard or not reporting is
 * simply not named. Read from the adapter's memory AFTER the commit, so it
 * can never turn a committed change into an error.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { mayReadLocksFor, type SecurityRouteDeps } from "../services/security-access.js";
import { securityLockAdapter, stillUnlockedLocks } from "../services/security-lock-adapter.js";
import { chainSafeText, hasUnsafeDisplayChars, isSecurityAuditUnavailable } from "../services/security-audit.js";
import { businessViewForRole } from "../services/business-profile.service.js";
import { ActivityChainPreconditionError } from "../services/activity.service.js";
import {
  HoursUnreadableError,
  actOnMode,
  deleteHoursException,
  readHoursView,
  readModeView,
  summaryName,
  writeHoursException,
  writeSiteHours,
  type HoursInput,
  type HoursWriteResult,
} from "../services/security-mode.service.js";
import { hhmmToMinutes, validateDay, validateWeek, type DayHours, type WeekdayHours } from "../lib/security-hours.js";
import { canonicalZone, isCalendarYmd, isValidIanaZone } from "../lib/zoned-time.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-site-routes");

const VIEW_ROLES = ["owner", "admin", "family"] as const;
const ACT_ROLES = ["owner", "admin", "family"] as const;
const MANAGE_ROLES = ["owner", "admin"] as const;

const DAY_KINDS = ["closed", "open_all_day", "hours"] as const;
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const VERSION = z.number().int().min(0).max(2_147_483_647);

const modeActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("open"), for: z.enum(["1h", "2h", "4h"]) }).strict(),
  z.object({ action: z.literal("away") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
]);

const dayInputSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    kind: z.enum(DAY_KINDS),
    opens: HHMM.optional(),
    closes: HHMM.optional(),
  })
  .strict();

const hoursBodySchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("set"),
      timezone: z.string().min(1).max(64),
      days: z.array(dayInputSchema).length(7),
      expectedVersion: VERSION,
    })
    .strict(),
  z.object({ state: z.literal("not_set"), expectedVersion: VERSION }).strict(),
]);

const exceptionBodySchema = z
  .object({
    kind: z.enum(DAY_KINDS),
    opens: HHMM.optional(),
    closes: HHMM.optional(),
    note: z.string().max(80).optional(),
    expectedVersion: VERSION,
  })
  .strict();

const deleteQuerySchema = z.object({ version: z.string().regex(/^\d{1,10}$/) }).strict();

type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_TIMEZONE"
  | "SAME_OPEN_CLOSE"
  | "MODE_UNAVAILABLE"
  | "HOURS_UNAVAILABLE"
  | "MODE_CONFLICT"
  | "VERSION_CONFLICT"
  | "AUDIT_UNAVAILABLE"
  | "HOURS_NOT_SET"
  | "EXCEPTION_NOT_FOUND"
  | "EXCEPTION_LIMIT"
  | "EXCEPTION_OUT_OF_RANGE"
  | "INTERNAL_ERROR";

function fail(res: Response, status: number, code: ErrorCode, message: string, issues?: unknown[]): void {
  res.status(status).json({ error: issues ? { code, message, issues } : { code, message } });
}

/**
 * A `{kind, opens?, closes?}` input as a day, or the reason it is not one:
 * times belong to `hours` only (VALIDATION_ERROR) and cannot be equal
 * (SAME_OPEN_CLOSE — that is "open all day").
 */
function dayFromInput(
  d: { kind: (typeof DAY_KINDS)[number]; opens?: string; closes?: string },
): { ok: true; day: DayHours } | { ok: false; code: "VALIDATION_ERROR" | "SAME_OPEN_CLOSE"; message: string } {
  if (d.kind !== "hours") {
    if (d.opens !== undefined || d.closes !== undefined) {
      return { ok: false, code: "VALIDATION_ERROR", message: "Times only go with kind 'hours'." };
    }
    return { ok: true, day: { kind: d.kind } };
  }
  const opensMin = d.opens === undefined ? null : hhmmToMinutes(d.opens);
  const closesMin = d.closes === undefined ? null : hhmmToMinutes(d.closes);
  if (opensMin === null || closesMin === null) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Kind 'hours' needs both an opening and a closing time." };
  }
  const day: DayHours = { kind: "hours", opensMin, closesMin };
  const issue = validateDay(day);
  if (issue === "SAME_OPEN_CLOSE") {
    return { ok: false, code: "SAME_OPEN_CLOSE", message: "Opening and closing times can't be the same. Use 'open all day'." };
  }
  if (issue) return { ok: false, code: "VALIDATION_ERROR", message: "A time is out of range." };
  return { ok: true, day };
}

/** The person on the request, as the mode write needs them. requireRole already guaranteed a role. */
function requester(req: Request) {
  const user = req.user!;
  return { req: { user: { id: user.id, role: user.role } }, id: user.id, name: summaryName(user.displayName || user.username) };
}

/**
 * A write that threw: 503 AUDIT_UNAVAILABLE when the audit could not be
 * written (the change rolled back with it), 500 for a programming error
 * (bad refs, a broken chain precondition), else 503 `unavailable`.
 */
function writeFailed(res: Response, err: unknown, unavailable: "MODE_UNAVAILABLE" | "HOURS_UNAVAILABLE", what: string): void {
  if (isSecurityAuditUnavailable(err)) {
    logger.error({ err }, `${what}: audit unavailable, nothing changed`);
    fail(res, 503, "AUDIT_UNAVAILABLE", "Nothing was changed: the audit log couldn't be written.");
    return;
  }
  if (err instanceof TypeError || err instanceof ActivityChainPreconditionError) {
    logger.error({ err }, `${what}: programming error`);
    fail(res, 500, "INTERNAL_ERROR", "Something went wrong on Droplet.");
    return;
  }
  logger.error({ err }, `${what} failed`);
  fail(
    res,
    503,
    unavailable,
    err instanceof HoursUnreadableError ? "The opening hours can't be read right now." : "The site mode can't be reached right now.",
  );
}

/** Map a rejected hours write onto its HTTP answer. */
function hoursRejected(res: Response, result: Exclude<HoursWriteResult, { status: "ok" }>): void {
  switch (result.status) {
    case "version_conflict":
      fail(res, 409, "VERSION_CONFLICT", "The opening hours changed since this page loaded.");
      return;
    case "hours_not_set":
      fail(res, 409, "HOURS_NOT_SET", "Set the usual opening hours before adding a special day.");
      return;
    case "out_of_range":
      fail(res, 422, "EXCEPTION_OUT_OF_RANGE", "A special day can be from yesterday up to a year ahead.");
      return;
    case "exception_limit":
      fail(res, 409, "EXCEPTION_LIMIT", "There are already 100 upcoming special days.");
      return;
    case "not_found":
      fail(res, 404, "EXCEPTION_NOT_FOUND", "There is no special day on that date.");
      return;
  }
}

/**
 * The hours view's `hint.typicalDay` is a business-profile field, so it
 * follows the profile's own audience ladder (§15): owner/admin only. A family
 * member at view or act gets "" — the profile API gives them the summary only.
 */
function mayReadTypicalDay(req: Request): boolean {
  return businessViewForRole(req.user?.role) === "full";
}

/**
 * After a committed hours write: both views, since the mode may have moved
 * with the hours. The write is committed and audited before this runs, so a
 * failed read-back is NEVER an error status: every 5xx on these routes means
 * nothing changed, and a client told "try again" would retry with the old
 * version and be told someone else had changed the hours — about its own
 * save. It answers 200 `{hours: null, mode: null}` instead: saved; re-read.
 */
async function answerWithViews(prisma: PrismaClient, req: Request, res: Response, now: Date): Promise<void> {
  let views: { hours: Awaited<ReturnType<typeof readHoursView>>; mode: Awaited<ReturnType<typeof readModeView>> } | null = null;
  try {
    views = {
      hours: await readHoursView(prisma, now, { profileHint: mayReadTypicalDay(req) }),
      mode: await readModeView(prisma, now),
    };
  } catch (err) {
    logger.error({ err }, "opening hours saved, but reading them back failed");
  }
  res.json(views ?? { hours: null, mode: null });
}

export function createSecuritySiteRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  const router = Router();
  const clock = (): Date => (deps.now ? deps.now() : new Date());
  const actGate = [sensitiveRateLimit, requireRole(...ACT_ROLES), requireFeatureAccess("security", "act", deps.resolve)];
  const manageGate = [
    sensitiveRateLimit,
    requireRole(...MANAGE_ROLES),
    requireFeatureAccess("security", "manage", deps.resolve),
  ];

  // 5 — the EFFECTIVE mode. Never a fake "open" on an outage.
  router.get("/security/mode", requireRole(...VIEW_ROLES), async (_req: Request, res: Response) => {
    try {
      res.json(await readModeView(prisma, clock()));
    } catch (err) {
      logger.error({ err }, "site mode read failed");
      fail(res, 503, "MODE_UNAVAILABLE", "The site mode can't be read right now.");
    }
  });

  // 6 — the hours, the special days, a 7-day preview, the timezone hint.
  router.get("/security/hours", requireRole(...VIEW_ROLES), async (req: Request, res: Response) => {
    try {
      res.json(await readHoursView(prisma, clock(), { profileHint: mayReadTypicalDay(req) }));
    } catch (err) {
      logger.error({ err }, "opening hours read failed");
      fail(res, 503, "HOURS_UNAVAILABLE", "The opening hours can't be read right now.");
    }
  });

  /**
   * WARP-2977 P2b-2 — the locks a Close up / Away answer names. In-memory
   * (the last sweep's locks and the readings last heard), and it runs after
   * the commit: a failure here is an empty list and a log line, never a 5xx.
   */
  const unlockedLocksNow = (): string[] => {
    try {
      return stillUnlockedLocks((deps.locks ?? securityLockAdapter)()?.knownLocks() ?? []);
    } catch (err) {
      logger.warn({ err }, "site mode changed; the door-lock list could not be read for the answer");
      return [];
    }
  };

  // 7 (act) — Close up / Open up / Away / Back to opening hours.
  router.post("/security/mode", ...actGate, async (req: Request, res: Response) => {
    const parsed = modeActionSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "VALIDATION_ERROR", "That isn't a mode change Droplet understands.", parsed.error.issues);
      return;
    }
    const namesLocks = parsed.data.action === "close" || parsed.data.action === "away";
    try {
      // BEFORE the change (DS-019): a resolver failure is a 503 with nothing
      // changed. The act gate already resolved this request, so it is the memo.
      const mayReadLocks = namesLocks && (await mayReadLocksFor(req, deps.resolve));
      const result = await actOnMode(prisma, requester(req), parsed.data, clock());
      if (result.status === "conflict") {
        fail(res, 409, "MODE_CONFLICT", "The mode was changed by someone else at the same moment. Try again.");
        return;
      }
      res.json({
        mode: result.mode,
        changed: result.changed,
        ...(mayReadLocks ? { unlockedLocks: unlockedLocksNow() } : {}),
      });
    } catch (err) {
      writeFailed(res, err, "MODE_UNAVAILABLE", "site mode change");
    }
  });

  // 13 (manage) — set or clear the weekly hours.
  router.put("/security/hours", ...manageGate, async (req: Request, res: Response) => {
    const parsed = hoursBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "VALIDATION_ERROR", "Those opening hours aren't in a shape Droplet understands.", parsed.error.issues);
      return;
    }
    const body = parsed.data;
    let input: HoursInput;
    if (body.state === "set") {
      const days: WeekdayHours[] = [];
      let sameOpenClose: { weekday: number; message: string } | null = null;
      for (const d of body.days) {
        const r = dayFromInput(d);
        if (!r.ok) {
          if (r.code === "VALIDATION_ERROR") {
            fail(res, 400, "VALIDATION_ERROR", r.message, [{ path: ["days", d.weekday], message: r.message }]);
            return;
          }
          sameOpenClose ??= { weekday: d.weekday, message: r.message };
          continue;
        }
        days.push({ weekday: d.weekday, ...r.day });
      }
      if (new Set(body.days.map((d) => d.weekday)).size !== 7) {
        fail(res, 400, "VALIDATION_ERROR", "Each weekday must appear exactly once.");
        return;
      }
      if (!isValidIanaZone(body.timezone)) {
        fail(res, 400, "INVALID_TIMEZONE", "That timezone isn't one Droplet knows.");
        return;
      }
      if (sameOpenClose) {
        fail(res, 400, "SAME_OPEN_CLOSE", sameOpenClose.message, [{ path: ["days", sameOpenClose.weekday], message: sameOpenClose.message }]);
        return;
      }
      const weekIssue = validateWeek(days);
      if (weekIssue) {
        fail(res, 400, weekIssue.code === "SAME_OPEN_CLOSE" ? "SAME_OPEN_CLOSE" : "VALIDATION_ERROR", weekIssue.message);
        return;
      }
      input = { state: "set", timezone: canonicalZone(body.timezone), days };
    } else {
      input = { state: "not_set" };
    }
    const now = clock();
    try {
      const result = await writeSiteHours(prisma, requester(req).req, input, body.expectedVersion, now);
      if (result.status !== "ok") {
        hoursRejected(res, result);
        return;
      }
    } catch (err) {
      writeFailed(res, err, "HOURS_UNAVAILABLE", "opening hours write");
      return;
    }
    await answerWithViews(prisma, req, res, now);
  });

  // 14 (manage) — add or replace one special day ('YYYY-MM-DD', site-local).
  router.put("/security/hours/exceptions/:date", ...manageGate, async (req: Request, res: Response) => {
    const date = req.params.date;
    if (!isCalendarYmd(date)) {
      fail(res, 400, "VALIDATION_ERROR", "The date must be a real calendar date, YYYY-MM-DD.");
      return;
    }
    const parsed = exceptionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "VALIDATION_ERROR", "That special day isn't in a shape Droplet understands.", parsed.error.issues);
      return;
    }
    const day = dayFromInput(parsed.data);
    if (!day.ok) {
      fail(res, 400, day.code, day.message);
      return;
    }
    const note = (parsed.data.note ?? "").trim();
    // Shown to every Security viewer and signed into the audit refs: no
    // controls (C0 or C1), line separators or bidi overrides / isolates.
    if (!chainSafeText(note) || hasUnsafeDisplayChars(note)) {
      fail(res, 400, "VALIDATION_ERROR", "The note has characters Droplet can't store.");
      return;
    }
    const now = clock();
    try {
      const result = await writeHoursException(
        prisma,
        requester(req).req,
        { date, day: day.day, note },
        parsed.data.expectedVersion,
        now,
      );
      if (result.status !== "ok") {
        hoursRejected(res, result);
        return;
      }
    } catch (err) {
      writeFailed(res, err, "HOURS_UNAVAILABLE", "special day write");
      return;
    }
    await answerWithViews(prisma, req, res, now);
  });

  // 15 (manage) — remove one special day. `?version=` is the hours version the page read.
  router.delete("/security/hours/exceptions/:date", ...manageGate, async (req: Request, res: Response) => {
    const date = req.params.date;
    if (!isCalendarYmd(date)) {
      fail(res, 400, "VALIDATION_ERROR", "The date must be a real calendar date, YYYY-MM-DD.");
      return;
    }
    const q = deleteQuerySchema.safeParse(req.query);
    const version = q.success ? Number(q.data.version) : NaN;
    if (!q.success || !VERSION.safeParse(version).success) {
      fail(res, 400, "VALIDATION_ERROR", "Say which version of the opening hours this page read (?version=N).");
      return;
    }
    try {
      const result = await deleteHoursException(prisma, requester(req).req, date, version, clock());
      if (result.status !== "ok") {
        hoursRejected(res, result);
        return;
      }
      res.status(204).end();
    } catch (err) {
      writeFailed(res, err, "HOURS_UNAVAILABLE", "special day delete");
    }
  });

  return router;
}
