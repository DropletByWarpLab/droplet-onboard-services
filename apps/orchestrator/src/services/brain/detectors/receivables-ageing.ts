/**
 * Receivables ageing trend (WARP-2825, ADR-051) — the first detector that
 * reads HISTORY rather than the present tense.
 *
 * `MoneySnapshot` (WARP-2751) has been written on every sync tick and by a
 * nightly sweep since it landed, and until now nothing read a single row of it.
 * This is the reader it was built for. `money-overdue.ts` says so in its own
 * opening paragraph: "ageing/DSO trend needs `MoneySnapshot` (WARP-2751)
 * because `land-money.ts` overwrites `ErpDocument` in place every 15 minutes
 * and destroys yesterday."
 *
 * THE QUESTION THIS ANSWERS, and the one it does not. "Our overdue balance has
 * doubled since June" is a trend, and a trend is the one thing a point-in-time
 * sweep can never see: `money.overdue-receivable` reports the same invoice at
 * 30 days and at 90 with no sense of whether the book as a whole is getting
 * better or worse. This detector answers direction. It does NOT answer DSO —
 * true days-sales-outstanding needs payments, and the box has no payment model
 * at all (no `ErpPayment`, no allocation, nothing that records money arriving).
 * Calling this DSO would be a fabricated number with a respectable name.
 *
 * WHY OVERDUE AND NOT TOTAL RECEIVABLES. A growing receivable book is often
 * just a growing business — invoice more, be owed more, and a "receivables up
 * 62%" finding would fire on the best month the company ever had. Overdue
 * cannot grow that way: a brand-new invoice is not past its due date, so it
 * contributes nothing to either endpoint. What moves this number is money
 * getting OLDER, which is the thing worth interrupting somebody about.
 *
 * OVERDUE IS EVALUATED AS OF EACH DAY, not as of today. A document is counted
 * in the anchor total only if it was already past due on the anchor DAY
 * (`d."dueAt" < s."capturedOn"`). Comparing "what is overdue today" against
 * "what those same documents were worth a month ago" would count today's
 * overdue set at both ends and report a rise every single time an invoice
 * crosses its due date.
 *
 * THE STATUS READ IS HISTORICAL TOO. The settled-word filter is applied to the
 * SNAPSHOT's `status` — the vendor's word as it stood on that day — not the
 * document's word today. A document paid last week was genuinely outstanding a
 * month ago, and rewriting the past with the present would show the book
 * improving purely because things eventually got paid.
 *
 * 🔴 IT REFUSES TO RUN ON A SHORT SERIES. If the oldest usable snapshot is
 * younger than MIN_SERIES_DAYS the detector returns nothing at all. A box three
 * days old would otherwise compare Tuesday with Friday and call it a monthly
 * trend — the shape of made-up number this module exists not to produce, and
 * the one an operator has no way to check. Silence is the correct output of a
 * trend detector with no trend to read.
 *
 * PER CURRENCY, NEVER SUMMED ACROSS THEM. Adding dollars to yen produces a
 * number that is wrong in a way nobody can see. Each currency is its own
 * finding with its own `subjectKey`, which is also what keeps the dedupe key
 * stable when a second currency appears on the box.
 *
 * 🔴 AND THE GATES RUN EVEN WHEN THE CURRENCY IS NULL, which on a shipped box
 * is the ordinary case rather than the exception — `ErpDocument.currency` is
 * NULL "when the ledger's own home currency is the only answer", and the
 * snapshot copies it. A gate that only fires when a currency happens to be
 * named is a gate that mostly does not fire. See `MIN_INCREASE_MAJOR`.
 */
import type { PrismaClient } from "@prisma/client";
import { minorUnitExponent, toMinorUnits } from "@droplet/shared-types";
import {
  SUBJECT_ERP_DOCUMENT,
  toUtcDateString,
} from "../../erp-sync/money-snapshot.service.js";
import type { Detector, DetectedFinding } from "./types";

/**
 * How far back to compare. Well inside `DROPLET_MONEY_SNAPSHOT_DAILY_DAYS`
 * (90), which is the window that still holds DAILY rows — beyond it the tail is
 * downsampled to one row per month and an exact day would usually miss.
 */
export const WINDOW_DAYS = 30;

/**
 * The series must reach back at least this far before any comparison is made.
 * Two weeks is the shortest span over which "the book is ageing" is a statement
 * about the business rather than about which day of the month it is: a single
 * large customer paying on their own monthly cycle moves a shorter window
 * entirely on its own.
 */
export const MIN_SERIES_DAYS = 14;

/** Report a rise only once it is this much of the earlier figure. Below it, a
 *  book that breathes normally would produce a finding most weeks, which is
 *  precisely the "three hundred findings" failure the registry warns about. */
export const GROWTH_RATIO = 1.25;

/** ...and only when the INCREASE itself is material. A book that went from
 *  $8 to $12 is up 50% and is not news. Minor units. */
export const MIN_INCREASE_MINOR = 50_000n; // 500.00

/**
 * 🔴 THE SAME FLOOR, IN MAJOR UNITS, FOR THE SERIES WHOSE CURRENCY NOBODY NAMED.
 *
 * `ErpDocument.currency` is NULL "when the ledger's own home currency is the
 * only answer — which is the ordinary case today" (schema, `ErpDocument`), and
 * `MoneySnapshot` copies that column verbatim. So the null-currency path is not
 * an edge case on a shipped box, it is the DEFAULT one.
 *
 * The first version of this detector applied `MIN_INCREASE_MINOR` only when a
 * minor-unit amount could be computed, which is exactly when a currency IS
 * known. A 2.00 → 8.00 move was therefore correctly silent in USD and fired a
 * digest finding with the currency omitted — the materiality gate did not
 * merely weaken on the common path, it did not run at all.
 *
 * Skipping such rows outright was the other candidate and is worse: it would
 * silence the detector on most boxes, which is the same as not shipping it.
 * So the gate falls back to the one unit that needs no exponent — the ledger's
 * own MAJOR units, as the vendor stated them. It is the identical 500.00 figure
 * for a two-decimal currency, which is what an unnamed home currency almost
 * always is, and `holds MIN_INCREASE_MAJOR and MIN_INCREASE_MINOR to the same
 * real figure` in the DB-less suite pins the two together so they cannot drift.
 *
 * Deliberately NOT used when the currency IS readable: there the exponent is
 * known, the minor-unit comparison is exact, and an approximation would be a
 * downgrade.
 */
export const MIN_INCREASE_MAJOR = 500; // 500.00 major units, exponent unknown

/**
 * Words a vendor uses for "this is settled", lowercased. Deliberately a COPY of
 * the set in `money-overdue.ts` rather than an import: that set is applied to a
 * document's CURRENT `vendorStatus`, this one to a snapshot's historical
 * `status` column, and the two are free to diverge — a vendor could add a word
 * that should end a live chase but must not retroactively erase a month of
 * history. Sharing one constant would couple those decisions silently.
 */
const SETTLED_WORDS = [
  "paid",
  "void",
  "voided",
  "cancelled",
  "canceled",
  "closed",
  "refunded",
];

/** One currency's two endpoints. `Decimal` arrives from pg as a string. */
type TrendRow = {
  currency: string | null;
  thenTotal: string | null;
  nowTotal: string | null;
  thenDay: Date | null;
  nowDay: Date | null;
};

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/** `Decimal(20,6)` major units -> minor, or null when the currency is unknown.
 *  Same all-or-nothing rule the sibling detector states: no currency, no
 *  number, and never a guessed exponent. */
export function toMinor(value: string | null, currency: string | null): bigint | null {
  if (value === null || !currency) return null;
  return toMinorUnits(value, currency);
}

/**
 * 🔴 WHY NO AMOUNT COULD BE COMPUTED — because there are TWO reasons and they
 * are not interchangeable.
 *
 * `toMinorUnits` returns null on an unrecognised currency AND on a value it
 * cannot represent exactly in that currency's minor unit. The first version of
 * this detector read a null back and reported ONE explanation for both:
 * "the ledger sent no readable currency". For a perfectly good USD series whose
 * `Decimal(20,6)` totals carry a fraction of a cent — which `MoneySnapshot`
 * stores to six places precisely so a vendor's sub-cent pricing survives — that
 * sentence is false, and the finding then erased a currency it knew perfectly
 * well.
 *
 * Wrong explanations are worse than missing ones here: an owner told the ledger
 * sent no currency will go looking at a connector that is working fine.
 *
 * `inexact-in-currency` is the only remaining cause once the currency is known:
 * the totals reach this function as a `::text` cast of a `SUM(numeric)`, which
 * is always a plain decimal, so `toMinorUnits`'s other refusals (separators,
 * exponent notation, no digits at all) cannot arise from this caller.
 */
export type AmountGap = "no-currency" | "inexact-in-currency";

/** Whether this string names a currency whose minor unit is knowable. Empty and
 *  non-ISO-4217 both count as absent — `minorUnitExponent` deliberately
 *  distinguishes "yen, exponent 0" from "I do not know what this is". */
export function currencyIsReadable(currency: string | null): boolean {
  return (
    typeof currency === "string" &&
    currency.trim() !== "" &&
    minorUnitExponent(currency) !== null
  );
}

/** `null` when an amount WAS computed; otherwise which of the two causes. */
export function amountGap(increaseMinor: bigint | null, currency: string | null): AmountGap | null {
  if (increaseMinor !== null) return null;
  return currencyIsReadable(currency) ? "inexact-in-currency" : "no-currency";
}

/** A percentage an owner reads, not a ratio. `120` means "up 120%". */
export function percentGrowth(then: number, now: number): number {
  if (then <= 0) return 0;
  return Math.round(((now - then) / then) * 100);
}

export const receivablesAgeing: Detector = {
  key: "money.receivables-ageing",
  description: "Overdue money owed to the business that is growing rather than being collected",

  async run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]> {
    // Both bounds are handed to Postgres as DAY STRINGS, through the very
    // function that wrote `capturedOn` in the first place. Passing a JS `Date`
    // and casting it with `::date` in SQL resolves against the SESSION's
    // TimeZone, so on a box or a CI runner that is not UTC the reader would
    // round to a different day than the writer did — and at the TOP bound that
    // silently excludes today's own snapshot. Same function, same day, no
    // dependence on a setting neither end controls.
    const windowStartDay = toUtcDateString(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
    const nowDay = toUtcDateString(now);

    // ONE query, in Postgres. The detector contract's reason is explicit: the
    // box runs a single inference at a time, and arithmetic over rows it
    // already holds belongs in the database. This also keeps both endpoints on
    // one consistent read rather than two round trips that could straddle a
    // sync tick.
    //
    // `anchor` is the OLDEST day at or after the window start, and `latest` the
    // newest day present. Both come from the data rather than from arithmetic
    // on `now`, so a box whose sync was down for a week compares the days it
    // actually has instead of silently reading zero for a day it never wrote.
    //
    // 🔴 THE WINDOW HAS A TOP AS WELL AS A BOTTOM. `latest` is the newest day
    // AS OF `now`, never simply the newest row in the table. A `capturedOn` in
    // the future is not a theoretical row — `MoneySnapshot` is keyed on a DATE
    // the writer computes from the box's own clock, and a box that boots with a
    // bad RTC (no network time yet, a dead coin cell) stamps tomorrow. Without
    // the cap that single row becomes the "now" endpoint forever: the real
    // present-day rows are then never compared, and the detector reports on a
    // day that has not happened. `now` is already a parameter for exactly this
    // kind of reason, so the fix costs one predicate.
    const rows = await prisma.$queryRaw<TrendRow[]>`
      WITH bounds AS (
        SELECT
          MIN("capturedOn") FILTER (WHERE "capturedOn" >= ${windowStartDay}::date) AS anchor,
          MAX("capturedOn") AS latest
        FROM "MoneySnapshot"
        WHERE "subjectType" = ${SUBJECT_ERP_DOCUMENT}
          AND "capturedOn" <= ${nowDay}::date
      ),
      overdue AS (
        SELECT
          s."capturedOn" AS day,
          s."currency"   AS currency,
          SUM(s."balance") AS total
        FROM "MoneySnapshot" s
        JOIN "ErpDocument" d ON d."id" = s."subjectId"
        CROSS JOIN bounds b
        WHERE s."subjectType" = ${SUBJECT_ERP_DOCUMENT}
          AND s."capturedOn" IN (b.anchor, b.latest)
          -- Money owed TO the business, from a vendor sync. A LOCAL document
          -- is one somebody on this box wrote and is born DRAFT; the sibling
          -- detector's note applies unchanged.
          AND d."kind" = 'INVOICE'
          AND d."origin" = 'LANDED'
          -- Overdue AS OF THAT DAY. A NULL dueAt is never past due, and NULL
          -- comparison yields NULL rather than true, which is the wanted
          -- behaviour and not an accident.
          AND d."dueAt" < s."capturedOn"
          AND s."balance" > 0
          AND lower(COALESCE(s."status", '')) <> ALL (${SETTLED_WORDS}::text[])
        GROUP BY s."capturedOn", s."currency"
      )
      SELECT
        c.currency                                        AS "currency",
        (SELECT total FROM overdue o
          WHERE o.currency IS NOT DISTINCT FROM c.currency
            AND o.day = (SELECT anchor FROM bounds))::text AS "thenTotal",
        (SELECT total FROM overdue o
          WHERE o.currency IS NOT DISTINCT FROM c.currency
            AND o.day = (SELECT latest FROM bounds))::text AS "nowTotal",
        (SELECT anchor FROM bounds)                        AS "thenDay",
        (SELECT latest FROM bounds)                        AS "nowDay"
      FROM (SELECT DISTINCT currency FROM overdue) c
    `;

    const out: DetectedFinding[] = [];

    for (const r of rows) {
      if (!r.thenDay || !r.nowDay) continue;

      // 🔴 The short-series refusal. Both endpoints exist, but if they are days
      // apart this is not a monthly trend and must not be described as one.
      const span = daysBetween(r.nowDay, r.thenDay);
      if (span < MIN_SERIES_DAYS) continue;

      // A currency present today and absent at the anchor reads as 0 then —
      // correct, and it is the "went from nothing to something" case, which the
      // ratio test below handles explicitly rather than dividing by zero.
      const thenNum = Number(r.thenTotal ?? "0");
      const nowNum = Number(r.nowTotal ?? "0");
      if (!Number.isFinite(thenNum) || !Number.isFinite(nowNum)) continue;
      if (nowNum <= thenNum) continue;

      const thenMinor = toMinor(r.thenTotal ?? "0", r.currency);
      const nowMinor = toMinor(r.nowTotal ?? "0", r.currency);

      // Impact is the INCREASE — what got worse — not the whole book. The
      // finding is about the movement, so reporting the total as its impact
      // would double-count against `money.overdue-receivable`, which already
      // reports the individual invoices making up that total.
      const increaseMinor =
        thenMinor !== null && nowMinor !== null ? nowMinor - thenMinor : null;

      // Two independent gates. The ratio keeps ordinary breathing out; the
      // absolute increase keeps a small book's noise out. Both must clear —
      // and 🔴 BOTH MUST CLEAR ON EVERY PATH, including the null-currency one
      // that is the ordinary case on a shipped box. See MIN_INCREASE_MAJOR.
      if (thenNum > 0 && nowNum / thenNum < GROWTH_RATIO) continue;
      if (increaseMinor !== null) {
        // Currency known: compare exactly, in that currency's own minor unit.
        if (increaseMinor < MIN_INCREASE_MINOR) continue;
      } else if (nowNum - thenNum < MIN_INCREASE_MAJOR) {
        // Currency unknown or the totals unrepresentable in it: fall back to
        // the ledger's own major units. `Number` is safe HERE and nowhere else
        // in this file — this is a threshold test whose answer cannot flip
        // from the rounding a 2^53-scale total would suffer, not a figure that
        // gets reported. The reported amount stays null a few lines below.
        continue;
      }

      const pct = percentGrowth(thenNum, nowNum);
      const cur = r.currency ?? "";
      const from = r.thenDay.toISOString().slice(0, 10);
      const to = r.nowDay.toISOString().slice(0, 10);

      // Which of the two reasons cost us the amount, if either. The currency
      // survives whenever it is READABLE — an amount we could not express is
      // not a reason to forget which denomination the totals are in.
      const gap = amountGap(increaseMinor, r.currency);
      const readable = currencyIsReadable(r.currency);
      const noAmountBecause =
        gap === null
          ? ""
          : gap === "no-currency"
            ? " The ledger sent no readable currency, so no amount is shown."
            : ` The totals carry more precision than ${cur} can express exactly, so no amount is shown.`;

      const rose =
        thenNum > 0
          ? `has grown ${pct}% in ${span} days`
          : `has appeared in the last ${span} days`;

      out.push({
        subjectKey: cur || "unknown-currency",
        kind: "risk",
        title: cur
          ? `Overdue ${cur} receivables ${rose}`
          : `Overdue receivables ${rose}`,
        rationale:
          `On ${from} the business was owed ${r.thenTotal ?? "0"} past its due date; ` +
          `on ${to} that figure is ${r.nowTotal ?? "0"}. ` +
          `New invoices cannot cause this — only invoices already past due are counted ` +
          `at either date — so money is being collected more slowly than it is falling due.` +
          noAmountBecause,
        // `risk`, not `loss`: the money is still owed and may well arrive. The
        // notification policy interrupts only for a large `loss`, which is
        // right — a trend is something to read on /brief, not a 3am buzz.
        impactMinor: increaseMinor,
        // Keyed off READABILITY, not off whether an amount came out. A USD
        // series whose totals are sub-cent still IS a USD series, and blanking
        // the currency there loses a fact the ledger stated plainly.
        currency: readable ? r.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "money_snapshot",
              sourceId: `${SUBJECT_ERP_DOCUMENT}:${from}`,
              quote: `Overdue receivable balance on ${from}: ${r.thenTotal ?? "0"} ${cur || "(no currency)"}`,
            },
            {
              sourceKind: "money_snapshot",
              sourceId: `${SUBJECT_ERP_DOCUMENT}:${to}`,
              quote: `Overdue receivable balance on ${to}: ${r.nowTotal ?? "0"} ${cur || "(no currency)"}`,
            },
          ],
        },
        // Longer series, more confidence — it is the span that makes a trend a
        // trend. Capped well short of certainty: this reads a vendor's own
        // numbers, and it cannot see a payment the vendor has not posted yet.
        confidence: Math.min(85, 40 + span),
      });
    }

    return out;
  },
};
