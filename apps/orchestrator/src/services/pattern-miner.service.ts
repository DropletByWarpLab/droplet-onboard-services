/**
 * WARP-464 (C3) — pattern miner.
 *
 * Reads ActivityRow rows of `kind=tool_call` from the trailing 7 days
 * and detects repeating n-grams (sliding window N=2..5) of tool names.
 * A sequence that appears ≥3 times becomes a suggestion: one
 * `ToolSpec(status=suggested)` row per unique sequence fingerprint.
 *
 * Fingerprint = SHA-256 of `JSON.stringify(toolNames[])`. Same
 * fingerprint already in `ToolSpec` (any status) = skip — operators
 * who've already accepted a suggestion don't get nagged about the
 * same pattern next hour.
 *
 * v1 is literal substring matching only — no embedding model, no
 * `ollama pull` for clustering. The §2.1 marketing promise ("Droplet
 * watches for repeated work and proposes tools") is backed by deterministic
 * algorithm operators can audit.
 *
 * Savings estimate: a coarse heuristic — `n_occurrences ×
 * SAVINGS_PER_OCCURRENCE_MINUTES`. The dashboard renders this as
 * "Saves ~N min/week" on the suggestion card.
 */
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import { WRITE_TOOLS } from "./tool-access.service.js";

const logger = createLogger("pattern-miner");

const WINDOW_DAYS = 7;
const MIN_NGRAM = 2;
const MAX_NGRAM = 5;
const MIN_OCCURRENCES = 3;
const SAVINGS_PER_OCCURRENCE_MINUTES = 5;
// Hard cap on suggestions per run — a chatty week shouldn't fill the
// Suggested tab with 200 noise cards. Top-K by occurrence count.
const MAX_SUGGESTIONS_PER_RUN = 10;

interface ActivityRowMin {
  id: bigint;
  at: Date;
  refs: unknown;
}

interface ToolSpecMin {
  id: string;
  slug: string;
  description: string | null;
  status: "live" | "draft" | "suggested";
}

interface DetectedPattern {
  fingerprint: string;
  toolNames: string[];
  occurrences: number;
}

export interface MineResult {
  inspected: number;
  patterns: number;
  inserted: number;
  skipped: number;
}

/**
 * Extract the canonical tool name from an ActivityRow's `refs` blob.
 * Recorders for kind=tool_call write `{ name, userId, ok }` (see
 * mcp-client.service.ts) — `name` is the registry tool name.
 */
function toolNameFromRow(row: ActivityRowMin): string | null {
  if (typeof row.refs !== "object" || row.refs === null) return null;
  const refs = row.refs as { name?: unknown };
  if (typeof refs.name !== "string" || refs.name.length === 0) return null;
  return refs.name;
}

function fingerprintOf(toolNames: readonly string[]): string {
  // Base64url-no-padding so the fingerprint is URL-safe (lands in
  // ToolSpec.slug and friendly diagnostic logs).
  return createHash("sha256")
    .update(JSON.stringify(toolNames))
    .digest("base64url");
}

/**
 * Slide N=2..5 windows over `sequence`; bucket each window by
 * fingerprint. Returns patterns with occurrences >= MIN_OCCURRENCES.
 *
 * Pure / side-effect-free — exported so tests can hit it directly.
 */
export function detectPatterns(sequence: readonly string[]): DetectedPattern[] {
  if (sequence.length < MIN_NGRAM) return [];
  const buckets = new Map<
    string,
    { toolNames: string[]; occurrences: number }
  >();
  for (let n = MIN_NGRAM; n <= MAX_NGRAM; n += 1) {
    if (sequence.length < n) break;
    for (let i = 0; i + n <= sequence.length; i += 1) {
      const window = sequence.slice(i, i + n);
      const fp = fingerprintOf(window);
      const existing = buckets.get(fp);
      if (existing) {
        existing.occurrences += 1;
      } else {
        buckets.set(fp, { toolNames: window, occurrences: 1 });
      }
    }
  }

  const out: DetectedPattern[] = [];
  for (const [fingerprint, b] of buckets) {
    if (b.occurrences >= MIN_OCCURRENCES) {
      out.push({
        fingerprint,
        toolNames: b.toolNames,
        occurrences: b.occurrences,
      });
    }
  }
  // Sort descending by occurrences so the dashboard's Suggested tab
  // ranks the most-used patterns first.
  out.sort((a, b) => b.occurrences - a.occurrences);
  return out;
}

/**
 * Top-level miner entry point. Idempotent: re-running on the same
 * 7-day window writes zero rows the second time because dedupe is by
 * fingerprint slug.
 */
export async function mineToolCallPatterns(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<MineResult> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400_000);
  const rows = (await prisma.activityRow.findMany({
    where: { kind: "tool_call", at: { gte: since } },
    orderBy: { at: "asc" },
    select: { id: true, at: true, refs: true },
  })) as unknown as ActivityRowMin[];

  const sequence: string[] = [];
  for (const row of rows) {
    const name = toolNameFromRow(row);
    if (name !== null) sequence.push(name);
  }

  const patterns = detectPatterns(sequence);
  if (patterns.length === 0) {
    return { inspected: rows.length, patterns: 0, inserted: 0, skipped: 0 };
  }

  // Dedupe against existing ToolSpec rows that already carry one of
  // these fingerprints — any status, not just `suggested`. An
  // operator who promoted the pattern to a draft / live spec should
  // not see the same suggestion next hour.
  const fingerprints = patterns.map((p) => p.fingerprint);
  const slugs = patterns.map((p) => slugFor(p.fingerprint));
  const existing = (await prisma.toolSpec.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true, description: true, status: true },
  })) as unknown as ToolSpecMin[];
  const existingSlugs = new Set(existing.map((e) => e.slug));

  const topK = patterns.slice(0, MAX_SUGGESTIONS_PER_RUN);

  let inserted = 0;
  let skipped = 0;
  for (const p of topK) {
    const slug = slugFor(p.fingerprint);
    if (existingSlugs.has(slug)) {
      skipped += 1;
      continue;
    }
    const savings =
      p.occurrences * SAVINGS_PER_OCCURRENCE_MINUTES;
    const description =
      `Droplet noticed you run ${p.toolNames.join(" → ")} repeatedly ` +
      `(${p.occurrences} times in the last ${WINDOW_DAYS} days). ` +
      `Promoting this to a tool could save ~${savings} min/week.`;
    await prisma.toolSpec.create({
      data: {
        slug,
        name: humanNameFor(p.toolNames),
        category: "suggested",
        description,
        status: "suggested" as any,
        safety: 1,
        // WARP-2665 — classify from the tools this pattern actually calls,
        // the same `WRITE_TOOLS` set (derived from each tool's
        // `requiresWrite`) that both routes in tools.ts use. A hardcoded
        // `false` here minted rows whose own steps contradicted their safety
        // flag: a mined `send_notification` sequence claimed it did not
        // write, and every gate downstream — the run-now confirmation, the
        // ticker's `writes && !reversible` skip, the Suggested tab's chip —
        // reads that stored value. The promotion route repairs the flag now,
        // but a row should not need repairing to be true.
        //
        // `p.toolNames` IS the step list: each name below becomes one
        // `kind:"call"` step with that tool, so classifying the names and
        // classifying the steps are the same operation here.
        writes: p.toolNames.some((tool) => WRITE_TOOLS.has(tool)),
        // `reversible` stays at the schema/route default. Unlike `writes` it
        // is operator-declared (schema.prisma:3135) and nothing in the
        // registry expresses undo-ability, so there is nothing to derive it
        // from — the miner matching `POST /tools`'s `?? true` is the
        // consistent posture, not an assertion of its own.
        reversible: true,
        steps: {
          create: p.toolNames.map((tool, idx) => ({
            idx,
            kind: "call",
            args: { tool, args: {} } as any,
          })),
        },
      },
    });
    inserted += 1;
  }

  if (inserted > 0) {
    logger.info({ inserted, skipped, patterns: patterns.length }, "pattern miner wrote suggestions");
  }
  // Suppress fingerprints we didn't write to keep `skipped` accurate
  // even when MAX_SUGGESTIONS_PER_RUN truncates the list.
  void fingerprints;

  return {
    inspected: rows.length,
    patterns: patterns.length,
    inserted,
    skipped,
  };
}

function slugFor(fingerprint: string): string {
  // ToolSpec.slug is kebab + lowercase per SLUG_RE in routes/tools.ts:
  //   /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  // Base64url is already lowercase-safe but may carry `_` and `-`.
  // Naive `_ → -` produces double hyphens (e.g. `_-` → `--`) and the
  // 32-char slice can end on a `-`/`_`, both of which fail the regex
  // and crash toolSpec.create on the hourly tick. Collapse runs of `-`
  // and strip leading/trailing dashes BEFORE adding the `sug-` prefix.
  const safe = fingerprint
    .toLowerCase()
    .replace(/_/g, "-")
    .slice(0, 32)
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return `sug-${safe}`;
}

function humanNameFor(toolNames: readonly string[]): string {
  // Prefix with "Suggested:" so the dashboard's Suggested tab is
  // obvious without joining on status. Truncate long sequences to a
  // 80-char display.
  const human = toolNames.join(" → ");
  const out = `Suggested: ${human}`;
  return out.length > 120 ? `${out.slice(0, 117)}...` : out;
}
