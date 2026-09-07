/**
 * WARP-2825 (ADR-051) — the receivables ageing detector's DB-less half.
 *
 * 🔴 WHAT THIS FILE CANNOT TELL YOU. The detector is one raw SQL statement, and
 * nothing here executes it. A mock `$queryRaw` returns what it was handed; it
 * cannot say whether the SQL parses, whether the parameters have inferable
 * types, or whether the join counts what it claims. That proof lives in
 * `receivables-ageing.pg.test.ts` and runs in the `pg-integration` lane.
 *
 * Believing otherwise is how `money-overdue.ts` shipped a query naming a
 * retired enum value and stayed green (WARP-2773) — its unit test handed it a
 * mock that ignored `where`. So this file deliberately covers only the two
 * halves a mock CAN prove:
 *
 *   the pure arithmetic  — growth percentage, minor-unit conversion, day span.
 *   the decision layer   — given endpoint totals, does a finding come out, and
 *                          does it say the right thing?
 *
 * The mock returns rows shaped exactly as the query's SELECT list produces
 * them, which is the one coupling worth keeping honest here.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { toMinorUnits } from "@droplet/shared-types";
import {
  receivablesAgeing,
  daysBetween,
  percentGrowth,
  toMinor,
  WINDOW_DAYS,
  MIN_SERIES_DAYS,
  GROWTH_RATIO,
  MIN_INCREASE_MINOR,
  MIN_INCREASE_MAJOR,
} from "../services/brain/detectors/receivables-ageing";

const NOW = new Date("2033-06-10T00:00:00.000Z");
const THEN = new Date("2033-05-01T00:00:00.000Z");

/** One row in the shape the detector's SELECT list produces. */
function row(over: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    thenTotal: "10000.00",
    nowTotal: "30000.00",
    thenDay: THEN,
    nowDay: NOW,
    ...over,
  };
}

function prismaReturning(rows: unknown[]): PrismaClient {
  return { $queryRaw: vi.fn(async () => rows) } as unknown as PrismaClient;
}

describe("receivables-ageing — arithmetic (WARP-2825)", () => {
  it("reports growth as a percentage an owner reads", () => {
    expect(percentGrowth(100, 300)).toBe(200);
    expect(percentGrowth(100, 125)).toBe(25);
    expect(percentGrowth(80, 100)).toBe(25);
  });

  it("returns 0 rather than Infinity when there was nothing before", () => {
    // A percentage against zero is not a number an owner can act on, and
    // "up Infinity%" is the kind of output that costs a feature its credibility.
    expect(percentGrowth(0, 5000)).toBe(0);
    expect(percentGrowth(-1, 5000)).toBe(0);
  });

  it("converts major units to minor with the CURRENCY's exponent", () => {
    // The bug the sibling detector shipped once: hundredths for everything is
    // wrong by 100x on a yen ledger.
    expect(toMinor("100.00", "USD")).toBe(10_000n);
    expect(toMinor("100", "JPY")).toBe(100n);
  });

  it("refuses to convert without a currency rather than assuming two decimals", () => {
    expect(toMinor("100.00", null)).toBeNull();
    expect(toMinor(null, "USD")).toBeNull();
  });

  it("counts whole days between two dates", () => {
    expect(daysBetween(NOW, THEN)).toBe(40);
    expect(daysBetween(THEN, THEN)).toBe(0);
  });

  it("keeps the comparison window inside the daily-retention window", () => {
    // Beyond DROPLET_MONEY_SNAPSHOT_DAILY_DAYS (90) the tail is downsampled to
    // one row per month, and an exact day would usually miss.
    expect(WINDOW_DAYS).toBeLessThan(90);
    expect(MIN_SERIES_DAYS).toBeLessThan(WINDOW_DAYS);
  });
});

describe("receivables-ageing — the decision (WARP-2825)", () => {
  it("emits a finding when both gates clear", async () => {
    const found = await receivablesAgeing.run(prismaReturning([row()]), NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.subjectKey).toBe("USD");
    expect(found[0]!.impactMinor).toBe(2_000_000n);
    expect(found[0]!.title).toContain("200%");
  });

  it("is a RISK, not a loss — the money may still arrive", async () => {
    // Consequence, not taxonomy: the notification policy interrupts only for a
    // large `loss`. A trend belongs on /brief, not in a 3am push.
    const found = await receivablesAgeing.run(prismaReturning([row()]), NOW);
    expect(found[0]!.kind).toBe("risk");
  });

  it("says NOTHING on a series shorter than MIN_SERIES_DAYS", async () => {
    const near = new Date(NOW.getTime() - 3 * 86_400_000);
    const found = await receivablesAgeing.run(
      prismaReturning([row({ thenDay: near, nowTotal: "900000.00" })]),
      NOW,
    );
    expect(found).toEqual([]);
  });

  it("says nothing when the book shrank or held flat", async () => {
    const shrank = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "30000.00", nowTotal: "10000.00" })]),
      NOW,
    );
    expect(shrank).toEqual([]);
    const flat = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "30000.00", nowTotal: "30000.00" })]),
      NOW,
    );
    expect(flat).toEqual([]);
  });

  it("says nothing on a rise below the ratio gate", async () => {
    const found = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "100000.00", nowTotal: "110000.00" })]),
      NOW,
    );
    expect(GROWTH_RATIO).toBeGreaterThan(1.1);
    expect(found).toEqual([]);
  });

  it("says nothing when the ratio is huge but the money is not", async () => {
    const found = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "2.00", nowTotal: "8.00" })]),
      NOW,
    );
    expect(MIN_INCREASE_MINOR).toBeGreaterThan(600n);
    expect(found).toEqual([]);
  });

  it("reports a book that appeared from nothing, and claims no percentage for it", async () => {
    // No ratio exists against zero. The sentence has to change with it, or the
    // finding would read "grown 0%" on a book that went from nothing to $30k.
    const found = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: null })]),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toContain("appeared");
    expect(found[0]!.title).not.toContain("%");
    expect(found[0]!.impactMinor).toBe(3_000_000n);
  });

  it("reports WITHOUT an amount when the currency is unreadable", async () => {
    // All-or-nothing, the sibling's rule: a trend is still legible as a
    // percentage, so the finding survives; the number does not get guessed.
    const found = await receivablesAgeing.run(
      prismaReturning([row({ currency: null })]),
      NOW,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.impactMinor).toBeNull();
    expect(found[0]!.currency).toBeNull();
    expect(found[0]!.rationale).toContain("no readable currency");
    expect(found[0]!.subjectKey).toBe("unknown-currency");
  });

  it("keeps two currencies as two findings", async () => {
    const found = await receivablesAgeing.run(
      prismaReturning([
        row(),
        row({ currency: "EUR", thenTotal: "5000.00", nowTotal: "20000.00" }),
      ]),
      NOW,
    );
    expect(found.map((f) => f.subjectKey).sort()).toEqual(["EUR", "USD"]);
  });

  it("cites BOTH endpoints, so the claim can be re-queried", async () => {
    // Evidence is what makes a finding auditable rather than merely asserted,
    // and the database rejects an empty `sources` array outright.
    const found = await receivablesAgeing.run(prismaReturning([row()]), NOW);
    const sources = found[0]!.evidence.sources;
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.sourceKind === "money_snapshot")).toBe(true);
    expect(sources[0]!.quote).toContain("2033-05-01");
    expect(sources[1]!.quote).toContain("2033-06-10");
  });

  it("gains confidence with the length of the series, and never claims certainty", async () => {
    const found = await receivablesAgeing.run(prismaReturning([row()]), NOW);
    expect(found[0]!.confidence).toBeGreaterThan(50);
    expect(found[0]!.confidence).toBeLessThanOrEqual(85);
  });

  it("survives a row with no endpoints rather than throwing", async () => {
    // `bounds` yields NULLs on an empty table, and the runner must not die on
    // a box that has never synced.
    const found = await receivablesAgeing.run(
      prismaReturning([row({ thenDay: null, nowDay: null })]),
      NOW,
    );
    expect(found).toEqual([]);
  });

  it("uses a stable subjectKey, so a repeat run upserts instead of duplicating", async () => {
    const a = await receivablesAgeing.run(prismaReturning([row()]), NOW);
    const b = await receivablesAgeing.run(prismaReturning([row({ nowTotal: "40000.00" })]), NOW);
    expect(a[0]!.subjectKey).toBe(b[0]!.subjectKey);
  });
});

/**
 * 🔴 THE MATERIALITY GATE ON THE PATH IT ACTUALLY RUNS ON.
 *
 * `ErpDocument.currency` is NULL "when the ledger's own home currency is the
 * only answer — which is the ordinary case today" (schema), and `MoneySnapshot`
 * copies that column. The first version of this detector applied
 * `MIN_INCREASE_MINOR` only where a minor-unit amount existed — i.e. only where
 * a currency was named — so the 500.00 floor did not fire on the common path at
 * all: 2.00 → 8.00 was silent in USD and a digest finding with no currency.
 *
 * Every case below is written as a PAIR, USD against NULL, because the defect
 * was invisible precisely as an asymmetry: each half looked reasonable alone.
 */
describe("receivables-ageing — the floor applies with or without a currency (WARP-2825)", () => {
  it("holds MIN_INCREASE_MAJOR and MIN_INCREASE_MINOR to the same real figure", () => {
    // Two constants, one materiality decision. Changing 500.00 in one place and
    // not the other would make the gate mean different things on the two paths,
    // which is the class of bug this whole block exists to close.
    expect(toMinorUnits(String(MIN_INCREASE_MAJOR), "USD")).toBe(MIN_INCREASE_MINOR);
  });

  it("stays silent below the floor — USD and NULL currency alike", async () => {
    // Up 300%, by six units. Not news in either.
    const usd = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "2.00", nowTotal: "8.00" })]),
      NOW,
    );
    const none = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: "2.00", nowTotal: "8.00" })]),
      NOW,
    );
    expect(usd).toEqual([]);
    // 🔴 This is the assertion the shipped code failed: with no currency there
    // was no minor-unit amount, so the floor was skipped and this fired.
    expect(none).toEqual([]);
  });

  it("reports above the floor — USD and NULL currency alike", async () => {
    const usd = await receivablesAgeing.run(
      prismaReturning([row({ thenTotal: "2000.00", nowTotal: "9000.00" })]),
      NOW,
    );
    const none = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: "2000.00", nowTotal: "9000.00" })]),
      NOW,
    );
    expect(usd).toHaveLength(1);
    expect(usd[0]!.impactMinor).toBe(700_000n);
    expect(none).toHaveLength(1);
    // The finding survives; the AMOUNT does not get guessed. All-or-nothing.
    expect(none[0]!.impactMinor).toBeNull();
    expect(none[0]!.currency).toBeNull();
    expect(none[0]!.subjectKey).toBe("unknown-currency");
  });

  it("sits the boundary on the floor itself, not near it", async () => {
    // Exactly 500.00 clears; a hundredth under does not. Pins the comparison as
    // `<` on the floor rather than an approximation of it.
    const at = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: "100.00", nowTotal: "600.00" })]),
      NOW,
    );
    const under = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: "100.00", nowTotal: "599.99" })]),
      NOW,
    );
    expect(at).toHaveLength(1);
    expect(under).toEqual([]);
  });

  it("gates a NULL-currency book that appeared from nothing on the same floor", async () => {
    // No ratio exists against zero, so the floor is the ONLY gate here. The
    // shipped code dropped this row unconditionally, which was the mirror image
    // of the same asymmetry: a currency-less book could never be reported no
    // matter how large, while a currency-less 6.00 rise always was.
    const big = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: null, nowTotal: "30000.00" })]),
      NOW,
    );
    const small = await receivablesAgeing.run(
      prismaReturning([row({ currency: null, thenTotal: null, nowTotal: "40.00" })]),
      NOW,
    );
    expect(big).toHaveLength(1);
    expect(big[0]!.title).toContain("appeared");
    expect(big[0]!.impactMinor).toBeNull();
    expect(small).toEqual([]);
  });
});
