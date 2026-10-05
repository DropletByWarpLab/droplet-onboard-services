/**
 * WARP-3527 — CSV parsing bounds and CSV export safety.
 */

import { describe, it, expect } from "vitest";
import {
  CSV_BOM,
  IMPORT_MAX_ROWS,
  ImportParseError,
  csvCell,
  csvLine,
  csvSafeText,
  parseCsvTable,
  sniffDelimiter,
} from "./csv.js";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("parseCsvTable", () => {
  it("strips a UTF-8 BOM so the first header is clean", () => {
    const t = parseCsvTable(buf("\ufeffTitle,Status\r\nA,Todo\r\n"));
    expect(t.headers).toEqual(["Title", "Status"]);
    expect(t.rows).toEqual([["A", "Todo"]]);
  });

  it("reads CRLF and bare-LF rows alike", () => {
    expect(parseCsvTable(buf("a,b\r\n1,2\r\n3,4\r\n")).rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseCsvTable(buf("a,b\n1,2\n3,4")).rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("keeps a quoted multi-line field and doubled quotes, line breaks normalised to LF", () => {
    const t = parseCsvTable(buf('Title,Description\r\nX,"line one\r\nline ""two"", with a comma"\r\n'));
    expect(t.rows[0][1]).toBe('line one\nline "two", with a comma');
  });

  it("keeps repeated headers (Jira writes one Labels column per label)", () => {
    const t = parseCsvTable(buf("Summary,Labels,Labels\nA,x,y\n"));
    expect(t.headers).toEqual(["Summary", "Labels", "Labels"]);
    expect(t.rows[0]).toEqual(["A", "x", "y"]);
  });

  it("sniffs ; and TAB delimiters, ignoring delimiters inside quotes", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n")).toBe("\t");
    expect(sniffDelimiter('"a,b,c,d";e\n')).toBe(";");
    expect(sniffDelimiter("single\nrow")).toBe(",");
    expect(parseCsvTable(buf("Title;Status\nA;Open\n")).rows).toEqual([["A", "Open"]]);
  });

  it("pads short rows, ignores extra cells, drops fully blank rows, and says so", () => {
    const t = parseCsvTable(buf("a,b,c\n1\n2,3,4,5\n,,\n6,7,8\n"));
    expect(t.rows).toEqual([["1", "", ""], ["2", "3", "4"], ["6", "7", "8"]]);
    expect(t.warnings.join(" ")).toMatch(/1 row has more cells/);
    expect(t.warnings.join(" ")).toMatch(/1 blank row skipped/);
  });

  it("names a blank header instead of losing the column", () => {
    expect(parseCsvTable(buf("a,,c\n1,2,3\n")).headers).toEqual(["a", "Column 2", "c"]);
  });

  it("tolerates a stray quote inside an unquoted field", () => {
    expect(parseCsvTable(buf('Title\n5" pipe\n')).rows).toEqual([['5" pipe']]);
  });

  it("rejects empty, binary and unterminated-quote files with a typed, plain-language error", () => {
    const code = (b: Buffer): string => {
      try {
        parseCsvTable(b);
      } catch (e) {
        return (e as ImportParseError).code;
      }
      return "no error";
    };
    expect(code(buf(""))).toBe("empty_file");
    expect(code(buf("  \n \n"))).toBe("empty_file");
    expect(code(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe("not_text");
    expect(code(buf('a,b\n"never closed,1\n'))).toBe("invalid_csv");
  });

  it("caps rows: exactly 20,000 passes, 20,001 is refused", () => {
    const ok = "t\n" + "x\n".repeat(IMPORT_MAX_ROWS);
    expect(parseCsvTable(buf(ok)).rows).toHaveLength(IMPORT_MAX_ROWS);
    const over = "t\n" + "x\n".repeat(IMPORT_MAX_ROWS + 1);
    try {
      parseCsvTable(buf(over));
      throw new Error("expected too_many_rows");
    } catch (e) {
      expect((e as ImportParseError).code).toBe("too_many_rows");
      expect((e as ImportParseError).message).toMatch(/20,000/);
    }
  });
});

describe("CSV export: formula injection (OWASP) and quoting", () => {
  it.each(["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tTAB", "\rCR"])(
    "prefixes an apostrophe to a text cell starting with %j",
    (v) => {
      expect(csvSafeText(v)).toBe(`'${v}`);
    },
  );

  it("leaves ordinary text, digits, keys and dates alone", () => {
    for (const v of ["Fix login", "INBOX-42", "2026-10-04", "42", "a=b", "x-y", ""]) {
      expect(csvSafeText(v)).toBe(v);
    }
  });

  it("quotes only when needed and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
  });

  it("neutralises BEFORE quoting, so the apostrophe sits inside the quotes", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it("does not touch a real number", () => {
    expect(csvCell(-5)).toBe("-5");
  });

  it("writes CRLF-terminated records and round-trips through the parser", () => {
    const rows = [
      ["key", "name", "description"],
      ["INBOX-1", "=cmd|' /C calc'!A0", 'He said "go", then\nleft'],
    ];
    const text = CSV_BOM + rows.map((r) => csvLine(r)).join("");
    const parsed = parseCsvTable(Buffer.from(text, "utf8"));
    expect(parsed.headers).toEqual(rows[0]);
    // the injected cell comes back with its guard, not as a live formula
    expect(parsed.rows[0][1].startsWith("'=")).toBe(true);
    expect(parsed.rows[0][2]).toBe('He said "go", then\nleft');
    expect(text.endsWith("\r\n")).toBe(true);
  });
});
