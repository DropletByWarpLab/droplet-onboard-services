/**
 * WARP-2475 — the rules `utcInstant` applies to a vendor modification
 * timestamp, tested apart from either connector because both depend on them
 * and neither owns them.
 *
 * The column this feeds is one a watermark TRUSTS (WARP-2464). That is what
 * makes "returns something plausible" the wrong bar here: a value that is
 * merely plausible advances the watermark, makes the mandatory sweep look
 * redundant, and stops edits being seen with nothing reporting a fault. So
 * every case below is either an exact instant or an explicit refusal, and
 * there is no third outcome.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import { utcInstant } from "../src/quickbooks/timestamp.js";

describe("an offset-qualified timestamp becomes a UTC instant", () => {
  it("converts a negative offset rather than truncating it", () => {
    // QBO's `MetaData.LastUpdatedTime` and QBD's `TimeModified` are both local
    // wall-clock plus an offset. Truncating the offset and keeping the wall
    // clock is the tempting mutation because the output still LOOKS like a
    // timestamp — it is just seven hours wrong.
    // Mutation: return `text.slice(0, 19) + "Z"` → 11:17:56Z → red.
    expect(utcInstant("2026-07-15T11:17:56-07:00")).toBe("2026-07-15T18:17:56.000Z");
  });

  it("converts a positive offset in the other direction", () => {
    // Guards against a sign error, which a single-fixture test cannot see: a
    // negated offset is still "a conversion happened" and still lands on a
    // plausible instant.
    // Mutation: negate the offset → 2026-07-15T20:17:56.000Z → red.
    expect(utcInstant("2026-07-15T11:17:56+02:00")).toBe("2026-07-15T09:17:56.000Z");
  });

  it("accepts an already-UTC Z timestamp", () => {
    // Mutation: require a [+-]HH:MM offset and reject Z → undefined → red.
    // Rejecting Z would blank the column on every host that prints it, which
    // looks identical to "this host has no timestamps".
    expect(utcInstant("2026-06-03T09:00:00Z")).toBe("2026-06-03T09:00:00.000Z");
  });

  it("keeps sub-second precision when a vendor sends it", () => {
    // Mutation: drop the fractional-seconds branch from the pattern →
    // undefined → red. Silently refusing a MORE precise timestamp is the
    // wrong way round.
    expect(utcInstant("2026-07-15T11:17:56.123-07:00")).toBe("2026-07-15T18:17:56.123Z");
  });

  it("tolerates surrounding whitespace, which XML text nodes carry", () => {
    // qbXML is pretty-printed; a text node can arrive padded.
    // Mutation: drop the `.trim()` → undefined → red, and QBD's whole column
    // goes blank against a real, correctly-formatted response.
    expect(utcInstant("  2026-06-03T09:00:00Z  ")).toBe("2026-06-03T09:00:00.000Z");
  });
});

describe("a timestamp that cannot be resolved honestly is refused", () => {
  it("refuses a NAIVE timestamp instead of guessing a zone", () => {
    // THE test of this module. `new Date("2026-07-06T08:30:00")` resolves a
    // naive string in the RUNNING PROCESS's zone and returns a confident,
    // wrong instant — and would make this suite machine-dependent, green in a
    // UTC CI runner and wrong on a box in Costa Mesa.
    //
    // Mutation: append "Z" before parsing → "2026-07-06T08:30:00.000Z" → red.
    // Mutation: `new Date(raw).toISOString()` with no offset gate → red
    //           anywhere TZ is not UTC.
    expect(utcInstant("2026-07-06T08:30:00")).toBeUndefined();
  });

  it("refuses an impossible calendar day, which Date.parse ROLLS OVER", () => {
    // Not a hypothetical bug class — verified against V8: `Date.parse` accepts
    // "2026-02-30T00:00:00Z" and yields March 2nd. A regex-only gate therefore
    // reports a malformed timestamp as a real one two days late, which is
    // exactly the silent-wrong-value failure this column must not have.
    //
    // Mutation: delete the calendar round-trip check in `utcInstant` →
    // "2026-03-02T00:00:00.000Z" → red.
    expect(utcInstant("2026-02-30T00:00:00Z")).toBeUndefined();
    // A real leap day must still pass, so the check rejects the impossible
    // rather than everything unusual.
    // Mutation: reject Feb 29 unconditionally → red.
    expect(utcInstant("2024-02-29T12:00:00Z")).toBe("2024-02-29T12:00:00.000Z");
  });

  it("refuses an impossible month and an impossible offset", () => {
    // These two the date parser does reject on its own; pinned so that a
    // future rewrite of the gate cannot quietly start admitting them.
    // Mutation: drop the Number.isFinite guard → "Invalid Date" throw → red.
    expect(utcInstant("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(utcInstant("2026-07-15T11:17:56+25:00")).toBeUndefined();
  });

  it("refuses malformed shapes rather than reading a prefix", () => {
    // Mutation: use `.test` on an unanchored pattern, or match a prefix →
    // the trailing-junk case parses → red.
    expect(utcInstant("2026-07-15")).toBeUndefined(); // date only
    expect(utcInstant("2026-07-15T11:17:56-0700")).toBeUndefined(); // offset without colon
    expect(utcInstant("2026-07-15T11:17:56-07:00 and then some")).toBeUndefined();
    expect(utcInstant("not a date")).toBeUndefined();
    expect(utcInstant("")).toBeUndefined();
  });

  it("refuses a non-string without throwing", () => {
    // The absent-field path both connectors rely on: QBO's `MetaData` may be
    // missing entirely, and a qbXML text node may be absent. A throw here
    // would fail a whole read over one odd document.
    // Mutation: drop the typeof guard → `.trim()` of undefined throws → red.
    for (const v of [undefined, null, 0, 12345, {}, [], true]) {
      expect(utcInstant(v)).toBeUndefined();
    }
  });
});
