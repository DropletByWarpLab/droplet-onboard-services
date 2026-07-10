/**
 * WARP-246 — CSV export for the admin audit viewer.
 *
 * The CSV is generated CLIENT-side from the already-fetched, filtered
 * rows (no new API surface — the sealed JSONL bundle from
 * POST /api/activity/export remains the verification-grade export).
 *
 * Contract under test:
 *   1. header row + one line per activity row, CRLF-terminated (RFC 4180);
 *   2. fields containing commas, quotes, or newlines are quoted, with
 *      internal quotes doubled;
 *   3. formula-injection hardening: cells beginning with = + - @ are
 *      prefixed with a leading apostrophe so spreadsheet apps treat
 *      them as text, not formulas;
 *   4. null `sub` serializes as an empty cell.
 */
import { describe, it, expect } from "vitest";
import { activityRowsToCsv, type AuditCsvRow } from "./audit-csv";

function makeRow(over: Partial<AuditCsvRow> = {}): AuditCsvRow {
  return {
    id: "1",
    at: "2026-06-30T10:00:00.000Z",
    kind: "system",
    severity: "info",
    what: "event",
    sub: null,
    ...over,
  };
}

describe("activityRowsToCsv (WARP-246)", () => {
  it("emits a header row plus one CRLF-terminated line per row", () => {
    const csv = activityRowsToCsv([makeRow({ id: "1" }), makeRow({ id: "2" })]);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("id,at,kind,severity,what,sub");
    expect(lines[1]).toContain("2026-06-30T10:00:00.000Z");
  });

  it("quotes fields containing commas and doubles internal quotes", () => {
    const csv = activityRowsToCsv([
      makeRow({ what: 'Renamed "family, photos" folder' }),
    ]);
    expect(csv).toContain('"Renamed ""family, photos"" folder"');
  });

  it("quotes fields containing newlines", () => {
    const csv = activityRowsToCsv([makeRow({ sub: "line one\nline two" })]);
    expect(csv).toContain('"line one\nline two"');
    // The embedded bare \n stays inside the quoted field — the CSV still
    // has exactly two CRLF-delimited records (header + 1 row).
    const records = csv.split("\r\n").filter((l) => l.length > 0);
    expect(records).toHaveLength(2);
  });

  it.each(["=", "+", "-", "@"])(
    "neutralizes a leading %s so spreadsheets treat the cell as text",
    (ch) => {
      const csv = activityRowsToCsv([makeRow({ what: `${ch}cmd|dangerous` })]);
      expect(csv).toContain(`'${ch}cmd`);
      expect(csv).not.toContain(`,${ch}cmd`);
    },
  );

  // WARP-1031 — Excel/Sheets trim leading whitespace before deciding a
  // cell is a formula, so a leader preceded by space/tab/CR is still
  // executable and must be neutralized too (OWASP CSV-injection).
  it.each([
    ["tab", "\t=cmd|' /C calc'!A0"],
    ["space", " =2+5|dangerous"],
    ["double space", "  @SUM(1+9)"],
    ["CR", "\r=1+1"],
    ["tab then minus", "\t-2+3"],
  ])(
    "neutralizes a %s-prefixed formula leader (WARP-1031)",
    (_label, cell) => {
      const csv = activityRowsToCsv([makeRow({ what: cell })]);
      expect(csv).toContain(`'${cell}`);
    },
  );

  it("leaves whitespace-led plain text un-neutralized", () => {
    const csv = activityRowsToCsv([makeRow({ what: " hello world" })]);
    expect(csv).toContain(", hello world,");
    expect(csv).not.toContain("' hello world");
  });

  it("serializes null sub as an empty cell", () => {
    const csv = activityRowsToCsv([makeRow({ sub: null })]);
    const row = csv.split("\r\n")[1]!;
    expect(row.endsWith(",")).toBe(true);
  });
});
