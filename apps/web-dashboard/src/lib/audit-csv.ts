/**
 * WARP-246 — client-side CSV export for the admin audit viewer.
 *
 * Generated from the rows the page has already fetched and filtered —
 * intentionally NOT a new API surface. The verification-grade export
 * (sealed JSONL with the chain's public bytes) already exists at
 * POST /api/activity/export; this CSV is the spreadsheet-friendly
 * convenience for "what happened last week" review.
 *
 * Two hardening rules beyond naive joining:
 *   - RFC 4180 quoting: fields containing `,` `"` `\n` `\r` are quoted
 *     and internal quotes doubled; records are CRLF-delimited.
 *   - Formula-injection neutralization: cells beginning with = + - @
 *     get a leading apostrophe so Excel/Sheets/Numbers render them as
 *     text instead of executing them as formulas (OWASP CSV-injection
 *     guidance). Activity `what`/`sub` strings can contain
 *     attacker-influenced text (filenames, device names), so this is
 *     load-bearing, not paranoia.
 */

export interface AuditCsvRow {
  id: string;
  at: string;
  kind: string;
  severity: string;
  what: string;
  sub: string | null;
}

const COLUMNS = ["id", "at", "kind", "severity", "what", "sub"] as const;

const FORMULA_LEADERS = new Set(["=", "+", "-", "@"]);

function escapeCell(value: string | null): string {
  if (value === null || value === "") return "";
  let out = value;
  if (FORMULA_LEADERS.has(out[0]!)) out = `'${out}`;
  if (/[",\n\r]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

export function activityRowsToCsv(rows: AuditCsvRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
