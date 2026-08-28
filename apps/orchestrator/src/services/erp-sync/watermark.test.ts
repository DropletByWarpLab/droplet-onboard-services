/**
 * WARP-2474 — which value a sync watermark advances on, and how two of them
 * are compared.
 *
 * `diffForDrift`'s watermark-behind cases live here rather than beside the
 * rest of `reconcile.ts` on purpose: the acceptance criterion is that the lag
 * is measured against THE SAME VALUE the advance used, and a test that sits in
 * a different file from the value's own contract is free to drift away from it
 * silently. Everything that agrees about the watermark is asserted in one
 * place.
 */
import { describe, it, expect } from "vitest";

import { diffForDrift, identify } from "./reconcile.js";
import {
  highestWatermark,
  isWatermarkAhead,
  isoInstant,
  watermarkValueOf,
} from "./watermark.js";

/**
 * A pair where the LEXICOGRAPHIC and the CHRONOLOGICAL answer disagree.
 *
 * `2026-08-09T23:00:00-05:00` is 2026-08-10T04:00Z — an hour of wall clock
 * LATER than `2026-08-10T00:00:00Z`, and a whole character-position EARLIER as
 * a string. Every "compares parsed Dates" assertion below rides this pair, so
 * reverting any of them to `a > b` on the raw strings inverts the answer
 * rather than merely making it fuzzy.
 */
const EARLIER_STRING_LATER_INSTANT = "2026-08-09T23:00:00-05:00";
const LATER_STRING_EARLIER_INSTANT = "2026-08-10T00:00:00Z";

describe("isoInstant", () => {
  it("parses a full ISO-8601 instant", () => {
    expect(isoInstant("2026-08-20T10:30:00Z")?.toISOString()).toBe("2026-08-20T10:30:00.000Z");
  });

  it("parses a date-only value — Shopify and Xero both emit them", () => {
    expect(isoInstant("2026-08-20")).toBeInstanceOf(Date);
  });

  it("refuses an opaque vendor cursor", () => {
    // Stripe's ordering token IS an object id. It must never be mistaken for
    // a time, because everything downstream of a Date is an ordering claim.
    expect(isoInstant("ch_3PjXqLKz9wQ1aBcD")).toBeNull();
  });

  it("refuses a bare number, which `new Date()` would read as a year", () => {
    // MUTATION: replace the anchored regex with a plain `Date.parse` guard →
    // `new Date("1001")` is the year 1001, so an invoice number becomes a
    // plausible timestamp → red.
    expect(isoInstant("1001")).toBeNull();
    expect(isoInstant("INV-1001")).toBeNull();
  });

  it("refuses null, undefined and the empty string", () => {
    expect(isoInstant(null)).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
    expect(isoInstant("")).toBeNull();
  });
});

describe("watermarkValueOf — the preference", () => {
  it("prefers a defined `updated_at` over the ordering key", () => {
    // The whole point of WARP-2464's column: a row whose only change is a
    // vendor-side modification moves `updated_at` and nothing else.
    // MUTATION: return `record.marker` unconditionally → red.
    expect(
      watermarkValueOf({ marker: "2026-08-20T00:00:00Z", updatedAt: "2026-08-25T00:00:00Z" }),
    ).toBe("2026-08-25T00:00:00Z");
  });

  it("falls back to the ordering key when `updated_at` is UNDEFINED", () => {
    // The QuickBooks Online / Desktop invoice+bill shape: the column is
    // present on the row and carries `undefined`, matching its `status`
    // precedent. A fallback that tests PRESENCE rather than definedness reads
    // this as "there is an updated_at" and hands the watermark `undefined`.
    //
    // MUTATION: `"updatedAt" in record ? record.updatedAt : record.marker` →
    // returns undefined → red.
    const value = watermarkValueOf({ marker: "2026-08-20T00:00:00Z", updatedAt: undefined });
    expect(value).toBe("2026-08-20T00:00:00Z");
    expect(value).not.toBeNull();
    expect(value).toBeDefined();
  });

  it("falls back when the column is ABSENT — the seven withheld datasets", () => {
    // `appointment`, `patient`, `account`, `ap_summary`, `campaign`,
    // `audience`, `balance_transaction` deliberately have no `updated_at`.
    const record = { marker: "2026-08-20T00:00:00Z" } as { marker: string | null };
    expect(watermarkValueOf(record as never)).toBe("2026-08-20T00:00:00Z");
  });

  it("falls back on null and on the empty string", () => {
    // An empty string sorts before every real timestamp, so treating it as a
    // value would silently reset the position rather than advance it.
    expect(watermarkValueOf({ marker: "2026-08-20T00:00:00Z", updatedAt: null })).toBe(
      "2026-08-20T00:00:00Z",
    );
    expect(watermarkValueOf({ marker: "2026-08-20T00:00:00Z", updatedAt: "" })).toBe(
      "2026-08-20T00:00:00Z",
    );
  });

  it("is null only when neither value exists", () => {
    expect(watermarkValueOf({ marker: null, updatedAt: undefined })).toBeNull();
  });
});

describe("highestWatermark", () => {
  it("compares parsed Dates, not strings", () => {
    // MUTATION: `if (best === null || value > best) best = value` on the raw
    // strings → picks the lexicographically larger, chronologically EARLIER
    // value → red.
    expect(
      highestWatermark([
        { marker: LATER_STRING_EARLIER_INSTANT, updatedAt: null },
        { marker: EARLIER_STRING_LATER_INSTANT, updatedAt: null },
      ]),
    ).toBe(EARLIER_STRING_LATER_INSTANT);
  });

  it("takes the preferred value from each row, not the ordering key", () => {
    expect(
      highestWatermark([
        { marker: "2026-08-26T00:00:00Z", updatedAt: null },
        { marker: "2026-08-20T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z" },
      ]),
    ).toBe("2026-08-27T00:00:00Z");
  });

  it("returns the LAST enumerated value for an all-opaque set — never a string max", () => {
    // Stripe cursors are object ids. The vendor's own enumeration order is the
    // only order an opaque token has, so the last one handed to us is its
    // high-water mark; sorting them is meaningless.
    // MUTATION: fall through to a lexicographic max → `ch_9zzz` → red.
    expect(
      highestWatermark([
        { marker: "ch_9zzz", updatedAt: null },
        { marker: "ch_1aaa", updatedAt: null },
      ]),
    ).toBe("ch_1aaa");
  });

  it("never lets an opaque value out-rank a real timestamp in a mixed set", () => {
    // MUTATION: drop the partition and compare everything as strings → `zzz`
    // beats every ISO value → red.
    expect(
      highestWatermark([
        { marker: "2026-08-20T00:00:00Z", updatedAt: null },
        { marker: "zzz-opaque", updatedAt: null },
        { marker: "2026-08-26T00:00:00Z", updatedAt: null },
      ]),
    ).toBe("2026-08-26T00:00:00Z");
  });

  it("is null for an empty set and for a set carrying no position at all", () => {
    expect(highestWatermark([])).toBeNull();
    expect(highestWatermark([{ marker: null, updatedAt: undefined }])).toBeNull();
  });
});

describe("isWatermarkAhead", () => {
  it("is false when there is no candidate", () => {
    expect(isWatermarkAhead(null, "2026-08-20T00:00:00Z")).toBe(false);
  });

  it("is true when there is no reference to be behind", () => {
    expect(isWatermarkAhead("2026-08-20T00:00:00Z", null)).toBe(true);
  });

  it("compares parsed Dates, not strings", () => {
    // MUTATION: `candidate > reference` on the raw strings → red in BOTH
    // directions, which is what makes this pair worth carrying.
    expect(isWatermarkAhead(EARLIER_STRING_LATER_INSTANT, LATER_STRING_EARLIER_INSTANT)).toBe(true);
    expect(isWatermarkAhead(LATER_STRING_EARLIER_INSTANT, EARLIER_STRING_LATER_INSTANT)).toBe(false);
  });

  it("is false for equal instants written differently", () => {
    expect(isWatermarkAhead("2026-08-10T04:00:00Z", "2026-08-09T23:00:00-05:00")).toBe(false);
  });

  it("refuses to order an opaque value on EITHER side", () => {
    // The explicit branch Romain's scope note asks for: an opaque token never
    // enters an ordering comparison, so it can never manufacture a lag report.
    // MUTATION: fall back to a string compare when either side fails to parse
    // → `ch_9zzz > ch_1aaa` → red.
    expect(isWatermarkAhead("ch_9zzz", "ch_1aaa")).toBe(false);
    expect(isWatermarkAhead("ch_9zzz", "2026-08-20T00:00:00Z")).toBe(false);
    expect(isWatermarkAhead("2026-08-20T00:00:00Z", "ch_1aaa")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// watermark-behind measures against the SAME value the advance used
// ---------------------------------------------------------------------------

/** Project rows exactly as the runner does, so the tests below cannot agree
 *  with an implementation the runner does not actually use. */
function project(rows: readonly Record<string, unknown>[]) {
  return identify(rows, "invoice_id", "issued_at", "updated_at");
}

describe("diffForDrift — watermark-behind", () => {
  it("fires when the full read's `updated_at` is ahead, though its ordering key is not", () => {
    // The Xero class, stated in the column WARP-2464 added: the document was
    // modified, so `updated_at` moved and `issued_at` did not. Measuring the
    // lag on the ordering key cannot see it.
    // MUTATION: measure against `r.marker` instead of the preferred value →
    // both sides sit at 2026-08-20, watermarkBehind is false → red.
    const drift = diffForDrift(
      "invoice",
      "2026-08-20T00:00:00Z",
      project([{ invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z", updated_at: undefined }]),
      project([
        { invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-27T00:00:00Z" },
      ]),
    );
    expect(drift.watermarkBehind).toBe(true);
    expect(drift.classes).toContain("watermark-behind");
  });

  it("compares those two values as instants, not as strings", () => {
    // MUTATION: `fullHigh > incHigh` on the raw strings → the offset value
    // reads as smaller and the lag disappears → red.
    const drift = diffForDrift(
      "invoice",
      null,
      project([{ invoice_id: "INV-1", issued_at: LATER_STRING_EARLIER_INSTANT }]),
      project([
        { invoice_id: "INV-1", issued_at: LATER_STRING_EARLIER_INSTANT },
        { invoice_id: "INV-2", issued_at: EARLIER_STRING_LATER_INSTANT },
      ]),
    );
    expect(drift.watermarkBehind).toBe(true);
  });

  it("does not manufacture a lag out of two opaque cursors", () => {
    // MUTATION: string-compare the opaque tokens → `ch_9zzz > ch_1aaa` reports
    // a lag that means nothing, on every sweep, for every Stripe connection →
    // red. A report an operator learns to ignore is worse than none.
    const drift = diffForDrift(
      "invoice",
      null,
      project([{ invoice_id: "INV-1", issued_at: "ch_1aaa" }]),
      project([
        { invoice_id: "INV-1", issued_at: "ch_1aaa" },
        { invoice_id: "INV-2", issued_at: "ch_9zzz" },
      ]),
    );
    expect(drift.watermarkBehind).toBe(false);
    expect(drift.classes).not.toContain("watermark-behind");
  });

  it("still reports a clean sweep when nothing is ahead", () => {
    // The negative case, so the three above are not vacuously true.
    const rows = project([
      { invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-27T00:00:00Z" },
    ]);
    const drift = diffForDrift("invoice", "2026-08-27T00:00:00Z", rows, rows);
    expect(drift.watermarkBehind).toBe(false);
    expect(drift.classes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// identify — the projection the preference reads
// ---------------------------------------------------------------------------

describe("identify — `updated_at` projection", () => {
  it("maps a present-and-UNDEFINED column to null, not to the string 'undefined'", () => {
    // *** THE MUTATION THIS TICKET NAMES ***
    // Replace the definedness test with a presence test
    // (`"updated_at" in rec ? String(rec.updated_at) : null`) and the
    // QuickBooks row — which carries the key with `undefined` — projects the
    // literal string "undefined", which then becomes the stored watermark.
    const [record] = identify(
      [{ invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z", updated_at: undefined }],
      "invoice_id",
      "issued_at",
      "updated_at",
    );
    expect(record.updatedAt).toBeNull();
    expect(record.updatedAt).not.toBe("undefined");
    expect(watermarkValueOf(record)).toBe("2026-08-20T00:00:00Z");
  });

  it("maps an absent column to null", () => {
    const [record] = identify(
      [{ invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z" }],
      "invoice_id",
      "issued_at",
      "updated_at",
    );
    expect(record.updatedAt).toBeNull();
  });

  it("carries a real `updated_at` through as a string", () => {
    const [record] = identify(
      [
        {
          invoice_id: "INV-1",
          issued_at: "2026-08-20T00:00:00Z",
          updated_at: "2026-08-27T00:00:00Z",
        },
      ],
      "invoice_id",
      "issued_at",
      "updated_at",
    );
    expect(record.updatedAt).toBe("2026-08-27T00:00:00Z");
    expect(record.marker).toBe("2026-08-20T00:00:00Z");
  });
});
