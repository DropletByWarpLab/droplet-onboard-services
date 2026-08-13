/**
 * WARP-1964 — the export-drop text layer: delimiter sniffing, RFC-4180 parsing,
 * byte-order-mark decoding, and cell normalization.
 *
 * These are pure functions, and they are where a practice's data is most likely
 * to be silently mangled: a mis-sniffed delimiter yields one giant column, a
 * mis-decoded UTF-16 export yields headers full of NULs, and a mis-parsed
 * amount is wrong by a factor of a thousand. Every case below is a real shape a
 * Windows report writer emits.
 */
import { describe, it, expect } from "vitest";
import {
  decodeExportBytes,
  DelimitedLimitError,
  parseDelimited,
  sniffDelimiter,
} from "../src/export-drop/csv.js";
import {
  normalizeText,
  parseExportTimestamp,
  parseMoney,
} from "../src/export-drop/values.js";

describe("delimiter sniffing", () => {
  it("picks the separator that splits the header row into the most fields", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(sniffDelimiter("a|b|c|d\n1|2|3|4")).toBe("|");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("ignores separators inside quoted fields", () => {
    // The quoted field has to be in the HEADER row: sniffing only ever looks at
    // the first record, so a quoted comma further down the file would not
    // exercise this at all. Two commas inside the quotes against one real tab —
    // counting naively picks the comma and collapses the file into one column.
    expect(sniffDelimiter('"Last, First, Middle"\tId\n"Smith, John, Q."\t7')).toBe("\t");
  });

  it("defaults to comma when nothing separates anything", () => {
    expect(sniffDelimiter("SingleColumn\nvalue")).toBe(",");
  });
});

describe("parseDelimited", () => {
  it("splits a plain comma file into headers and rows", () => {
    const table = parseDelimited("Patient ID,First Name\n1,Ada\n2,Grace\n");
    expect(table.headers).toEqual(["Patient ID", "First Name"]);
    expect(table.rows).toEqual([
      ["1", "Ada"],
      ["2", "Grace"],
    ]);
  });

  it("does not emit a phantom record for a trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n").rows).toHaveLength(1);
    expect(parseDelimited("a,b\r\n1,2\r\n").rows).toHaveLength(1);
  });

  it("keeps a quoted field containing the delimiter as one value", () => {
    const table = parseDelimited('Name,Id\n"Smith, John",7');
    expect(table.rows[0]).toEqual(["Smith, John", "7"]);
  });

  it("keeps a quoted field containing a newline as one value", () => {
    const table = parseDelimited('Note,Id\n"line one\nline two",7');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][0]).toBe("line one\nline two");
  });

  it("reads a doubled quote as one literal quote", () => {
    const table = parseDelimited('Name,Id\n"He said ""hi""",7');
    expect(table.rows[0][0]).toBe('He said "hi"');
  });

  it("normalizes CRLF inside a quoted field", () => {
    const table = parseDelimited('Note,Id\r\n"one\r\ntwo",7\r\n');
    expect(table.rows[0][0]).toBe("one\ntwo");
  });

  it("handles CRLF record separators", () => {
    const table = parseDelimited("a,b\r\n1,2\r\n3,4");
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses a tab-delimited export", () => {
    const table = parseDelimited("AptNum\tPatNum\n11\t22");
    expect(table.headers).toEqual(["AptNum", "PatNum"]);
    expect(table.rows[0]).toEqual(["11", "22"]);
  });

  it("keeps a short row short rather than padding it", () => {
    // A missing trailing field means the column is absent, which the projection
    // layer turns into undefined — the same thing a NULL column yields.
    const table = parseDelimited("a,b,c\n1,2");
    expect(table.rows[0]).toEqual(["1", "2"]);
  });

  it("keeps a row of genuinely empty fields", () => {
    const table = parseDelimited("a,b,c\n,,");
    expect(table.rows).toEqual([["", "", ""]]);
  });

  it("throws once the row ceiling is passed", () => {
    const text = "a\n1\n2\n3\n";
    expect(() => parseDelimited(text, { maxRows: 2 })).toThrow(DelimitedLimitError);
    expect(() => parseDelimited(text, { maxRows: 3 })).not.toThrow();
  });

  it("returns empty headers for empty input", () => {
    expect(parseDelimited("")).toEqual({ headers: [], rows: [], delimiter: "," });
  });
});

describe("decodeExportBytes", () => {
  it("strips a UTF-8 byte-order mark so it cannot glue onto the first header", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Patient ID,X")]);
    const text = decodeExportBytes(bytes);
    expect(text.startsWith("Patient ID")).toBe(true);
    expect(parseDelimited(text).headers[0]).toBe("Patient ID");
  });

  it("decodes a UTF-16LE export (what a .NET StreamWriter writes by default)", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Patient ID,First Name\n1,Ada", "utf16le"),
    ]);
    const table = parseDelimited(decodeExportBytes(bytes));
    expect(table.headers).toEqual(["Patient ID", "First Name"]);
    expect(table.rows[0]).toEqual(["1", "Ada"]);
  });

  it("decodes a UTF-16BE export", () => {
    const le = Buffer.from("Patient ID,X\n1,2", "utf16le");
    const be = Buffer.from(le);
    be.swap16();
    const table = parseDelimited(decodeExportBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])));
    expect(table.headers).toEqual(["Patient ID", "X"]);
  });

  it("passes plain UTF-8 through unchanged", () => {
    expect(decodeExportBytes(Buffer.from("Naïve,X"))).toBe("Naïve,X");
  });
});

describe("normalizeText", () => {
  it("turns an empty or whitespace-only cell into undefined, like a NULL column", () => {
    expect(normalizeText("")).toBeUndefined();
    expect(normalizeText("   ")).toBeUndefined();
    expect(normalizeText(undefined)).toBeUndefined();
    expect(normalizeText("  Ada  ")).toBe("Ada");
  });
});

describe("parseExportTimestamp", () => {
  it("parses ISO with and without a time", () => {
    expect(parseExportTimestamp("2026-08-14T09:30:00Z")).toBe("2026-08-14T09:30:00.000Z");
    expect(parseExportTimestamp("2026-08-14 09:30")).toBe("2026-08-14T09:30:00.000Z");
    expect(parseExportTimestamp("2026-08-14")).toBe("2026-08-14T00:00:00.000Z");
  });

  it("parses the US layout a Windows report writer emits, including AM/PM", () => {
    expect(parseExportTimestamp("8/14/2026 9:30 AM")).toBe("2026-08-14T09:30:00.000Z");
    expect(parseExportTimestamp("08/14/2026 2:05 PM")).toBe("2026-08-14T14:05:00.000Z");
    expect(parseExportTimestamp("8/14/2026 12:00 AM")).toBe("2026-08-14T00:00:00.000Z");
    expect(parseExportTimestamp("8/14/2026 12:30 PM")).toBe("2026-08-14T12:30:00.000Z");
    expect(parseExportTimestamp("8/14/2026 14:05")).toBe("2026-08-14T14:05:00.000Z");
  });

  it("honours an explicit offset", () => {
    expect(parseExportTimestamp("2026-08-14T09:30:00-07:00")).toBe("2026-08-14T16:30:00.000Z");
    expect(parseExportTimestamp("2026-08-14T09:30:00+02:00")).toBe("2026-08-14T07:30:00.000Z");
  });

  it("treats a zone-less value as UTC so this track agrees with scheduleDayBounds", () => {
    // scheduleDayBounds builds `${date}T00:00:00.000Z` bounds, so the SQL track
    // already compares practice-local wall-clock against UTC. Converting here
    // would make the two tracks disagree about which appointments are "today",
    // and would make the box's own TZ change the answer.
    expect(parseExportTimestamp("2026-08-14 00:00")).toBe("2026-08-14T00:00:00.000Z");
  });

  it("returns undefined for something that is not a date", () => {
    expect(parseExportTimestamp("no date here")).toBeUndefined();
    expect(parseExportTimestamp("")).toBeUndefined();
    expect(parseExportTimestamp(undefined)).toBeUndefined();
    expect(parseExportTimestamp("8/14/2026 25:00")).toBeUndefined();
  });

  it("rejects an impossible date instead of silently rolling it over", () => {
    // Date.UTC(2026, 12, 45) is a perfectly valid instant next year. Left
    // unchecked, a column mis-mapped to appt_time turns into a confident wrong
    // appointment time rather than an honest "cannot place this row".
    expect(parseExportTimestamp("13/45/2026")).toBeUndefined();
    expect(parseExportTimestamp("2026-02-30")).toBeUndefined();
    expect(parseExportTimestamp("2026-13-01")).toBeUndefined();
    expect(parseExportTimestamp("2026-00-10")).toBeUndefined();
    expect(parseExportTimestamp("8/14/2026 13:00 PM")).toBeUndefined();
    // ...while a real leap day still parses.
    expect(parseExportTimestamp("2028-02-29")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rejects out-of-range minutes and seconds, which roll within the same day", () => {
    // These are the ones the calendar round-trip cannot see: 9:70 would quietly
    // become 10:10 on the correct date, so an appointment moves by 40 minutes
    // and nothing looks wrong.
    expect(parseExportTimestamp("8/14/2026 09:70")).toBeUndefined();
    expect(parseExportTimestamp("2026-08-14 09:30:99")).toBeUndefined();
    expect(parseExportTimestamp("2026-08-14 09:59:59")).toBe("2026-08-14T09:59:59.000Z");
  });
});

describe("parseMoney", () => {
  it("parses a plain amount", () => {
    expect(parseMoney("1234.56")).toBe(1234.56);
    expect(parseMoney("0")).toBe(0);
  });

  it("strips a currency symbol and thousands separators", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("1,234")).toBe(1234);
    expect(parseMoney("$12,345,678.90")).toBe(12345678.9);
  });

  it("reads parentheses as negative, which is what an AR ageing report prints", () => {
    expect(parseMoney("(1,234.56)")).toBe(-1234.56);
    expect(parseMoney("($45.00)")).toBe(-45);
  });

  it("handles leading and trailing signs", () => {
    expect(parseMoney("-45.10")).toBe(-45.1);
    expect(parseMoney("45.10-")).toBe(-45.1);
    expect(parseMoney("+45.10")).toBe(45.1);
  });

  it("treats the LAST separator as the decimal point when both appear", () => {
    expect(parseMoney("1.234,56")).toBe(1234.56);
    expect(parseMoney("1,234.56")).toBe(1234.56);
  });

  it("disambiguates a lone comma by the digits that follow it", () => {
    expect(parseMoney("12,50")).toBe(12.5); // two digits -> decimal
    expect(parseMoney("1,234")).toBe(1234); // three digits -> thousands
    expect(parseMoney("1,234,567")).toBe(1234567); // several commas -> thousands
  });

  it("returns undefined for a non-numeric cell rather than zero", () => {
    // Zero would be a lie that lands straight in an AR total.
    expect(parseMoney("n/a")).toBeUndefined();
    expect(parseMoney("")).toBeUndefined();
    expect(parseMoney(undefined)).toBeUndefined();
    expect(parseMoney("--")).toBeUndefined();
  });
});
