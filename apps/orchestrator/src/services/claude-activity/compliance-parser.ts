/**
 * WARP-279 — Compliance-progress.md parser.
 *
 * docs/compliance-progress.md is a hand-maintained markdown file that's the
 * source of truth for "where are we against SOC 2 / HIPAA / FIPS 140-3 /
 * NIST 800-53". The dashboard surfaces it as three structured tables
 * rather than a raw markdown render so we can show counts, badges, and a
 * percentage bar.
 *
 * We deliberately keep the parser conservative: it tolerates markdown that
 * doesn't match the expected shape (returns empty arrays for the section
 * that doesn't parse) rather than throwing. The file is hand-edited, so
 * "the dashboard noticed the table moved" is a useful signal but should
 * never break the rest of the dashboard.
 *
 * Status emojis we look for, mapped to the same TicketStatus enum the
 * Jira adapter uses:
 *   ✅  done
 *   🟡  in_progress
 *   🔵  not_started   (called "todo" elsewhere; "not_started" reads better here)
 *   ❌  blocked
 *   ⏸  deferred       (rendered as not_started for counts)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("claude-activity:compliance");

export type ComplianceStatus =
  | "done"
  | "in_progress"
  | "not_started"
  | "blocked"
  | "deferred"
  | "na"
  | "unknown";

export interface WorkstreamRow {
  workstream: string;
  total: number;
  done: number;
  in_progress: number;
  not_started: number;
}

export interface QueueRow {
  index: number;
  ticket: string;
  title: string;
  workstream: string;
  status: ComplianceStatus;
}

export interface MilestoneRow {
  milestone: string;
  trigger: string;
  status: ComplianceStatus;
}

export interface ComplianceSnapshot {
  /** Source path the snapshot was parsed from (relative to repo root). */
  source: string;
  /** Last-modified mtime of the source file (ms epoch). null if unread. */
  source_mtime_ms: number | null;
  /** When the parse ran. */
  generated_at: string;
  /** "Workstream rollup" table. Empty if the table isn't found. */
  workstreams: WorkstreamRow[];
  /** "Sequential ticket queue" table. */
  queue: QueueRow[];
  /** "Audit + certification milestones" table. */
  milestones: MilestoneRow[];
  /** True when at least one of the three tables parsed at all. */
  parsed: boolean;
}

const STATUS_EMOJI: Record<string, ComplianceStatus> = {
  "✅": "done",
  "🟡": "in_progress",
  "🔵": "not_started",
  "❌": "blocked",
  "⏸": "deferred",
  "N/A": "na",
};

function classifyStatusCell(cell: string): ComplianceStatus {
  // Strip markdown emphasis + spaces and look for any known emoji.
  const trimmed = cell.trim();
  for (const [emoji, status] of Object.entries(STATUS_EMOJI)) {
    if (trimmed.includes(emoji)) return status;
  }
  // Some rows are textual ("not started"). Match a few common ones.
  const lower = trimmed.toLowerCase();
  if (lower.includes("done")) return "done";
  if (lower.includes("in progress")) return "in_progress";
  if (lower.includes("not started")) return "not_started";
  if (lower.includes("blocked")) return "blocked";
  if (lower.includes("deferred")) return "deferred";
  if (lower.includes("n/a")) return "na";
  return "unknown";
}

/** Resolve docs/compliance-progress.md relative to cwd, with overrides. */
export function resolveComplianceDocPath(): string {
  const override = process.env.COMPLIANCE_PROGRESS_PATH;
  if (override && override.length > 0) {
    return path.isAbsolute(override) ? override : path.resolve(override);
  }
  return path.resolve(process.cwd(), "docs/compliance-progress.md");
}

/**
 * Parse the markdown body. Exported for unit tests to feed in a fixture
 * string directly.
 */
export function parseComplianceMarkdown(markdown: string): {
  workstreams: WorkstreamRow[];
  queue: QueueRow[];
  milestones: MilestoneRow[];
} {
  const workstreams = parseWorkstreams(markdown);
  const queue = parseQueue(markdown);
  const milestones = parseMilestones(markdown);
  return { workstreams, queue, milestones };
}

/**
 * Read the file from disk + parse. Always resolves; never throws.
 */
export async function readComplianceProgress(
  filePath: string = resolveComplianceDocPath(),
): Promise<ComplianceSnapshot> {
  const generatedAt = new Date().toISOString();
  let raw: string;
  let mtime: number | null = null;
  try {
    raw = await readFile(filePath, "utf8");
    // Best-effort mtime — the dashboard uses it as a hint to the
    // Last-Modified header.
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(filePath);
      mtime = s.mtimeMs;
    } catch {
      mtime = null;
    }
  } catch (err) {
    logger.warn({ err, filePath }, "compliance-progress.md unreadable");
    return {
      source: filePath,
      source_mtime_ms: null,
      generated_at: generatedAt,
      workstreams: [],
      queue: [],
      milestones: [],
      parsed: false,
    };
  }

  const parsed = parseComplianceMarkdown(raw);
  const anyParsed =
    parsed.workstreams.length > 0 ||
    parsed.queue.length > 0 ||
    parsed.milestones.length > 0;

  return {
    source: filePath,
    source_mtime_ms: mtime,
    generated_at: generatedAt,
    ...parsed,
    parsed: anyParsed,
  };
}

// ─────────────────────── parsing internals ────────────────────────

/**
 * Pull the markdown table that follows a section heading. Returns the
 * table body rows (excluding header + separator).
 */
function extractTableUnder(markdown: string, headingRegex: RegExp): string[] {
  const headingMatch = headingRegex.exec(markdown);
  if (!headingMatch) return [];
  const after = markdown.slice(headingMatch.index + headingMatch[0].length);
  // Find the first markdown table — header line of pipes, then a separator,
  // then body rows. We split on lines and walk until we find the table,
  // then collect body rows until a non-pipe line (or another heading).
  const lines = after.split("\n");
  let i = 0;
  // Skip blank lines until we hit a pipe row.
  while (i < lines.length && !lines[i]!.trim().startsWith("|")) i++;
  // Header.
  if (i >= lines.length) return [];
  i++;
  // Separator (|---|---|).
  if (i >= lines.length || !/^\s*\|[\s\-:|]+\|\s*$/.test(lines[i]!)) return [];
  i++;
  const body: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line.startsWith("|")) break;
    body.push(line);
    i++;
  }
  return body;
}

function splitRow(row: string): string[] {
  // Drop the leading + trailing pipes, then split on remaining ones.
  const inner = row.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function parseWorkstreams(markdown: string): WorkstreamRow[] {
  const rows = extractTableUnder(markdown, /^##\s+Workstream rollup\s*$/im);
  const out: WorkstreamRow[] = [];
  for (const row of rows) {
    const cells = splitRow(row);
    // Expected: workstream | tickets | done | in_progress | not_started
    if (cells.length < 5) continue;
    // Skip the totals row — emboldened ("**Total**" etc.). We expose the
    // total via the queue length in any case.
    const wsRaw = cells[0]!;
    if (wsRaw.includes("Total")) continue;
    const ws = wsRaw.replace(/\*\*/g, "").trim();
    const total = Number.parseInt(cells[1]!.replace(/\*\*/g, "").trim(), 10);
    const done = Number.parseInt(cells[2]!.replace(/\*\*/g, "").trim(), 10);
    const ip = Number.parseInt(cells[3]!.replace(/\*\*/g, "").trim(), 10);
    const ns = Number.parseInt(cells[4]!.replace(/\*\*/g, "").trim(), 10);
    if (
      ws.length === 0 ||
      Number.isNaN(total) ||
      Number.isNaN(done) ||
      Number.isNaN(ip) ||
      Number.isNaN(ns)
    )
      continue;
    out.push({ workstream: ws, total, done, in_progress: ip, not_started: ns });
  }
  return out;
}

function parseQueue(markdown: string): QueueRow[] {
  const rows = extractTableUnder(markdown, /^##\s+Sequential ticket queue\s*$/im);
  const out: QueueRow[] = [];
  for (const row of rows) {
    const cells = splitRow(row);
    // Expected: # | Ticket | Title | Workstream | Status
    if (cells.length < 5) continue;
    const idx = Number.parseInt(cells[0]!.trim(), 10);
    const ticketCell = cells[1]!.trim();
    // Ticket is a markdown link like [WARP-229](https://...). Strip to key.
    const ticketMatch = /\[(WARP-\d+)\]/i.exec(ticketCell);
    const ticket = ticketMatch ? ticketMatch[1]! : ticketCell.replace(/\*+/g, "");
    const title = cells[2]!.trim();
    const ws = cells[3]!.trim();
    const status = classifyStatusCell(cells[4]!);
    if (Number.isNaN(idx) || ticket.length === 0) continue;
    out.push({ index: idx, ticket, title, workstream: ws, status });
  }
  return out;
}

function parseMilestones(markdown: string): MilestoneRow[] {
  const rows = extractTableUnder(
    markdown,
    /^##\s+Audit \+ certification milestones\s*$/im,
  );
  const out: MilestoneRow[] = [];
  for (const row of rows) {
    const cells = splitRow(row);
    if (cells.length < 3) continue;
    const milestone = cells[0]!.replace(/\*\*/g, "").trim();
    const trigger = cells[1]!.trim();
    const status = classifyStatusCell(cells[2]!);
    if (milestone.length === 0) continue;
    out.push({ milestone, trigger, status });
  }
  return out;
}
