/**
 * KAN-6 — one-shot legacy SceneSchedule timezone backfill.
 *
 * THE PROBLEM. Pre-KAN-6 rows stored the schedule's fire time as a UTC value
 * in the RRULE BYHOUR (a UTC-7 / PDT owner who picked 07:00 has BYHOUR=14).
 * The timezone-column migration (20260628000000) back-fills timezone='UTC' on
 * every existing row but leaves BYHOUR untouched. The new describeRrule reads
 * BYHOUR as WALL-CLOCK in the row's timezone, so for a non-UTC home it now
 * DISPLAYS the UTC hour (14:00 / "2:00 PM") instead of the local one the owner
 * picked (07:00 / "7:00 AM"). Firing is unaffected by the column add (UTC rows
 * take rrule.ts's UTC fast-path), but the display is wrong.
 *
 * THE FIX (owner-approved data decision). Convert every legacy (timezone='UTC')
 * row to the box's configured local IANA zone such that:
 *   (a) the FIRING INSTANT is unchanged — the row's nextFireAt is the same UTC
 *       instant before and after; and
 *   (b) the DISPLAYED local hour is correct again — BYHOUR/BYMINUTE are
 *       rewritten from the stored UTC wall-clock to the box-zone wall-clock at
 *       that same instant (UTC 14 → 7 for America/Los_Angeles), so
 *       describeRrule shows the right local time.
 * We do NOT change the firing math to do this — only the stored rrule + the
 * timezone column. The offset used is the one that actually applies to the
 * row's next fire (read at nextFireAt), so the freshly-recomputed nextFireAt
 * lands on exactly the original instant.
 *
 * ONE-SHOT + IDEMPOTENT. The conversion can't run as pure SQL (it needs the
 * box's local zone, resolvable only at Node runtime) so it runs once at
 * startup, right after `prisma migrate deploy`, and records completion in
 * SystemFlag. Every later boot short-circuits on the flag — so a row authored
 * later through the UI (with its real zone) is NEVER touched. At first run,
 * every existing row is legacy by definition, so converting all timezone='UTC'
 * rows is correct.
 *
 * FALL-BACK. If the box zone is unresolvable (or already 'UTC'), no row is
 * converted; we still write the flag so we don't re-scan on every boot. We
 * never throw — a backfill must not wedge orchestrator startup.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  isSupportedRrule,
  isSupportedTimezone,
  localWallClockOf,
  nextFireFromRrule,
} from "../utils/rrule.js";

const logger = pino({ name: "scene-schedule-tz-backfill" });

/** SystemFlag key: presence = this backfill has completed (never re-run). */
export const SCENE_TZ_BACKFILL_FLAG_KEY = "kan6.scene_schedule_tz_backfill";

export interface BackfillResult {
  /** Did the backfill body execute this boot (false = short-circuited on flag). */
  ran: boolean;
  /** Legacy rows rewritten to the box zone. */
  converted: number;
  /** Legacy rows skipped (malformed rrule / wall-clock unreadable). */
  skipped: number;
}

interface BackfillOptions {
  /**
   * The box's local IANA zone. `undefined` → resolve via `resolveBoxTimezone()`
   * (TZ env → Intl resolved zone). `null` → explicitly "nothing resolvable"
   * (no conversion; used in tests to exercise the fall-back). A string
   * overrides the resolver outright.
   */
  boxTimezone?: string | null;
  now?: Date;
}

interface LegacyRow {
  id: string;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
}

/**
 * The box's configured local IANA zone: `process.env.TZ` if it's a resolvable
 * identifier, else the Node/ICU-resolved zone. Returns null if nothing
 * resolvable (caller leaves rows as UTC).
 */
export function resolveBoxTimezone(): string | null {
  const fromEnv = process.env.TZ;
  if (fromEnv && isSupportedTimezone(fromEnv)) return fromEnv;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && isSupportedTimezone(resolved)) return resolved;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Rewrite the BYHOUR / BYMINUTE params of an RRULE body to `hour` / `minute`,
 * leaving FREQ / BYDAY / INTERVAL / BYSECOND and ordering otherwise intact.
 * Params present are replaced in place; BYHOUR/BYMINUTE absent are appended
 * (BYHOUR=0 / BYMINUTE=0 are the parser defaults, so appending matches the
 * pre-conversion semantics). The leading `RRULE:` prefix, if any, is preserved.
 */
export function rewriteRruleWallClock(
  rrule: string,
  hour: number,
  minute: number,
): string {
  const prefixMatch = rrule.match(/^RRULE:/i);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const body = prefix ? rrule.slice(prefix.length) : rrule;

  const segments = body.split(";");
  let sawHour = false;
  let sawMinute = false;
  const rewritten = segments.map((seg) => {
    const eq = seg.indexOf("=");
    if (eq <= 0) return seg;
    const key = seg.slice(0, eq).toUpperCase();
    if (key === "BYHOUR") {
      sawHour = true;
      return `BYHOUR=${hour}`;
    }
    if (key === "BYMINUTE") {
      sawMinute = true;
      return `BYMINUTE=${minute}`;
    }
    return seg;
  });
  if (!sawHour) rewritten.push(`BYHOUR=${hour}`);
  if (!sawMinute) rewritten.push(`BYMINUTE=${minute}`);
  return prefix + rewritten.join(";");
}

/**
 * Run the one-shot legacy timezone backfill. Idempotent: a SystemFlag marker
 * short-circuits every run after the first. Never throws.
 */
export async function backfillLegacySceneScheduleTimezones(
  prisma: PrismaClient,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const now = opts.now ?? new Date();
  const boxTimezone =
    opts.boxTimezone === undefined ? resolveBoxTimezone() : opts.boxTimezone;

  // Already done on a prior boot → nothing to do.
  const existing = await prisma.systemFlag.findUnique({
    where: { key: SCENE_TZ_BACKFILL_FLAG_KEY },
  });
  if (existing) {
    return { ran: false, converted: 0, skipped: 0 };
  }

  let converted = 0;
  let skipped = 0;

  // No resolvable box zone (or it's already UTC) → no conversion to do, but
  // still record completion so we don't re-scan on every boot.
  const convertible =
    boxTimezone !== null && boxTimezone !== "UTC" && isSupportedTimezone(boxTimezone);

  if (convertible) {
    const legacy = (await prisma.sceneSchedule.findMany({
      where: { timezone: "UTC" },
    })) as unknown as LegacyRow[];

    for (const row of legacy) {
      // Only rewrite rows whose rrule we actually understand; a malformed /
      // unsupported rule is left exactly as-is (the ticker already disables it)
      // rather than corrupted.
      if (!isSupportedRrule(row.rrule)) {
        skipped += 1;
        continue;
      }
      // The local wall-clock the row's CURRENT next fire maps to in the box
      // zone — i.e. the hour/minute the owner actually intended. Read at the
      // real fire instant so the offset (DST-correct for that fire) is right.
      const local = localWallClockOf(row.nextFireAt, boxTimezone!);
      if (local === null) {
        skipped += 1;
        continue;
      }
      const newRrule = rewriteRruleWallClock(row.rrule, local.hour, local.minute);
      // Recompute nextFireAt from the new (zone-aware) rule. This MUST land on
      // the original instant — that's invariant (a). Compute from just before
      // the original fire so "today's" occurrence is the one we get back.
      const probe = new Date(row.nextFireAt.getTime() - 1);
      const recomputed = nextFireFromRrule(newRrule, probe, boxTimezone!);
      const nextFireAt = recomputed ?? row.nextFireAt;

      await prisma.sceneSchedule.update({
        where: { id: row.id },
        data: { rrule: newRrule, timezone: boxTimezone!, nextFireAt },
      });
      converted += 1;
    }
  }

  // Record completion in the same transaction window. A racing second boot
  // (multi-replica) that lost the create hits P2002 — swallow it; the marker
  // already exists, which is the desired end state.
  try {
    await prisma.systemFlag.create({
      data: {
        key: SCENE_TZ_BACKFILL_FLAG_KEY,
        valueJson: {
          boxTimezone: boxTimezone ?? null,
          converted,
          skipped,
          ranAt: now.toISOString(),
        },
      },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "P2002") {
      logger.warn({ err }, "scene-schedule tz backfill: marker write failed");
    }
  }

  if (converted > 0 || skipped > 0) {
    logger.info(
      { converted, skipped, boxTimezone },
      "scene-schedule tz backfill complete",
    );
  }
  return { ran: true, converted, skipped };
}
