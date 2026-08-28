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
// missed-newer — WARP-2495
// ---------------------------------------------------------------------------

describe("diffForDrift — missed-newer", () => {
  it("reports a record whose `updated_at` is after the watermark though its ordering key is not", () => {
    // *** THE CASE THIS TICKET NAMES ***
    // `issued_at (2026-08-10) < watermark (2026-08-20) < updated_at
    // (2026-08-26)`. Once WARP-2474 made the watermark an `updated_at`, the
    // predicate was still comparing the row's ORDERING key against it, and
    // `updated_at >= issued_at` in general — so every row whose modification
    // is newer than the watermark but whose issue date is older was filtered
    // out of the report. The sweep under-reported drift in exactly the
    // direction a sweep exists to catch.
    //
    // MUTATION: restore the string compare
    // `if (watermark !== null && (r.marker === null || r.marker <= watermark)) continue;`
    // → "2026-08-10T00:00:00Z" <= "2026-08-20T00:00:00Z", the row is skipped,
    // missedCount is 0 → red.
    const drift = diffForDrift(
      "invoice",
      "2026-08-20T00:00:00Z",
      project([]),
      project([
        {
          invoice_id: "INV-1",
          issued_at: "2026-08-10T00:00:00Z",
          updated_at: "2026-08-26T00:00:00Z",
        },
      ]),
    );
    expect(drift.missedCount).toBe(1);
    expect(drift.classes).toContain("missed-newer");
  });

  it("compares the record against the watermark as instants, not as strings", () => {
    // The same offset pair every other comparison here rides. The record's
    // value is an hour LATER than the watermark and a character-position
    // EARLIER, so a string compare skips it and reports no drift at all.
    //
    // MUTATION: `r.marker <= watermark` on the raw strings → the row is
    // skipped → missedCount 0 → red.
    const drift = diffForDrift(
      "invoice",
      LATER_STRING_EARLIER_INSTANT,
      project([]),
      project([{ invoice_id: "INV-1", issued_at: EARLIER_STRING_LATER_INSTANT }]),
    );
    expect(drift.missedCount).toBe(1);
  });

  it("never orders two opaque tokens — no finding either way", () => {
    // The Stripe shape: the ordering token IS an object id. `ch_9zzz` vs
    // `ch_1aaa` has a lexicographic ANSWER and it means nothing, so the
    // predicate must not consult it — the same call `watermark-behind`
    // already refuses to make. A report an operator learns to ignore is worse
    // than none, and here it would fire on every sweep of every Stripe
    // connection.
    //
    // MUTATION: `r.marker <= watermark` → "ch_9zzz" > "ch_1aaa" is true, the
    // row is counted → missedCount 1 → red.
    const drift = diffForDrift(
      "invoice",
      "ch_1aaa",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "ch_9zzz" }]),
    );
    expect(drift.missedCount).toBe(0);
    expect(drift.classes).not.toContain("missed-newer");

    // ...and the mirror image, so "opaque is never ordered" is asserted rather
    // than a coincidence of which token happens to sort higher. A string
    // compare answers these two OPPOSITELY; the predicate answers both the
    // same way.
    const mirrored = diffForDrift(
      "invoice",
      "ch_9zzz",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "ch_1aaa" }]),
    );
    expect(mirrored.missedCount).toBe(0);
  });

  it("does not order an opaque record against an ISO watermark, or the reverse", () => {
    // A mixed pair is still unorderable, and the two halves must agree.
    // "INV-2" sorts ABOVE "2026-…" as a string, so a string compare reports
    // the first of these as drift and the second as clean.
    const opaqueRecord = diffForDrift(
      "invoice",
      "2026-08-20T00:00:00Z",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "INV-2" }]),
    );
    const opaqueWatermark = diffForDrift(
      "invoice",
      "INV-2",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "2026-08-26T00:00:00Z" }]),
    );
    expect(opaqueRecord.missedCount).toBe(0);
    expect(opaqueWatermark.missedCount).toBe(0);
  });

  it("still filters out a record the vendor correctly withheld", () => {
    // The negative case, so the four above are not vacuously true: a row at or
    // before the watermark was already delivered by the run that set it.
    // MUTATION: make the comparison non-strict (`>=` on the instants) → the
    // row sitting EXACTLY at the watermark is reported → drift on every sweep,
    // forever → red.
    const before = diffForDrift(
      "invoice",
      "2026-08-20T00:00:00Z",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "2026-08-10T00:00:00Z" }]),
    );
    const exactly = diffForDrift(
      "invoice",
      "2026-08-20T00:00:00Z",
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "2026-08-20T00:00:00Z" }]),
    );
    expect(before.missedCount).toBe(0);
    expect(exactly.missedCount).toBe(0);
    expect(before.classes).toEqual([]);
  });

  it("reports everything the incremental read omitted when there is no watermark yet", () => {
    // A null watermark filtered nothing, so absence from the incremental read
    // is drift on its own evidence and needs no comparison at all.
    const drift = diffForDrift(
      "invoice",
      null,
      project([]),
      project([{ invoice_id: "INV-1", issued_at: "2026-08-10T00:00:00Z" }]),
    );
    expect(drift.missedCount).toBe(1);
  });

  it("does not report a record the incremental read DID return", () => {
    // Presence in A is checked before the watermark is consulted at all.
    const rows = project([
      {
        invoice_id: "INV-1",
        issued_at: "2026-08-10T00:00:00Z",
        updated_at: "2026-08-26T00:00:00Z",
      },
    ]);
    expect(diffForDrift("invoice", "2026-08-20T00:00:00Z", rows, rows).missedCount).toBe(0);
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
