/**
 * WARP-900 — shared RFC 4180 CSV helper used by `convert-format.ts`.
 */
import { describe, it, expect } from "vitest";
import { parseCsvRows, stringifyCsvRows } from "../../../src/handlers/data/_csv.js";

describe("parseCsvRows", () => {
  it("parses a simple comma-separated table", () => {
    expect(parseCsvRows("a,b\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles a trailing newline without producing a phantom empty row", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsvRows('name,note\n"Doe, Jane",hi')).toEqual([
      ["name", "note"],
      ["Doe, Jane", "hi"],
    ]);
  });

  it("handles quoted fields with embedded newlines", () => {
    expect(parseCsvRows('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("handles doubled quotes as an escaped literal quote", () => {
    expect(parseCsvRows('a\n"she said ""hi"""')).toEqual([["a"], ['she said "hi"']]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsvRows('a\n"unterminated')).toThrow(/unterminated/);
  });

  it("returns no rows for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
  });
});

describe("stringifyCsvRows", () => {
  it("joins rows with CRLF and fields with commas", () => {
    expect(
      stringifyCsvRows([
        ["a", "b"],
        ["1", "2"],
      ]),
    ).toBe("a,b\r\n1,2");
  });

  it("quotes fields containing a comma, quote, or newline; doubles embedded quotes", () => {
    const csv = stringifyCsvRows([["Doe, Jane", 'she said "hi"', "line1\nline2"]]);
    expect(csv).toBe('"Doe, Jane","she said ""hi""","line1\nline2"');
  });

  it("round-trips through parse -> stringify -> parse", () => {
    const original = [
      ["name", "note"],
      ["Doe, Jane", 'she said "hi"'],
      ["Plain", "line1\nline2"],
    ];
    const csv = stringifyCsvRows(original);
    expect(parseCsvRows(csv)).toEqual(original);
  });
});
