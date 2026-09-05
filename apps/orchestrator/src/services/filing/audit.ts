/**
 * WARP-2731 (ADR-048) — the audit row, and the exact set of keys it may carry.
 *
 * 🔴 IDS, CODES AND COUNTS. NOTHING ELSE.
 *
 * Never a filename, a subject line, a company name, an amount or a quote. The
 * audit stream is the one table in this design that is exported wholesale
 * (`POST /api/activity/export` seals and signs a bundle), read by more people
 * than the CRM, and retained longer than the proposals it describes. A field
 * that leaks here leaks further and for longer than anywhere else in the
 * feature, and it leaks in a bundle somebody may have already handed to an
 * auditor.
 *
 * The key set is asserted by a test that fails on any EXTRA key, not just a
 * missing one — because the failure mode is additive: someone adds `path` to
 * "make the audit more useful", every row afterwards carries a filename, and
 * nothing goes red.
 *
 * ── ⚠ An honest limit ─────────────────────────────────────────────────────
 *
 * This guarantee covers rows written BY FILING. It does not cover the stream.
 * `services/activity-file-indexer-bridge.ts` already writes `Indexed
 * ${filename}` into `ActivityRow` on every index, and `EntityLink.fileName`
 * caches a filename on a CRM row. Both predate this design and neither is
 * ours to change here. The runbook (WARP-2736) must say "filing writes no
 * filenames" rather than "the activity stream contains none", because the
 * second is false and a runbook that overclaims is worse than one that omits.
 */
import { getActivityRecorder } from "../activity.singleton.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("filing-audit");

/**
 * The complete set of `refs` keys a filing audit row may carry.
 *
 * Exported so the test asserts against THIS rather than restating it — a
 * second copy of the list is a second thing to keep in step, and the one that
 * drifts is always the test.
 */
export const FILING_AUDIT_REF_KEYS = [
  "sourceRef",
  "sourceKind",
  "extractStatus",
  "extractReason",
  "phiVerdict",
  "proposalsCreated",
  "proposalsDuplicate",
  "droppedUnverified",
  "droppedPhi",
  "model",
  "phiSignals",
] as const;

export type FilingAuditRefKey = (typeof FILING_AUDIT_REF_KEYS)[number];

export interface FilingAuditRefs {
  /** `file:<ncFileId>` or `email:<uuid>`. An ID, not a path. */
  sourceRef: string;
  sourceKind: "FILE" | "EMAIL";
  extractStatus: string;
  extractReason?: string | null;
  phiVerdict?: string | null;
  proposalsCreated?: number;
  proposalsDuplicate?: number;
  droppedUnverified?: number;
  droppedPhi?: number;
  /** The model tag. Not a secret, and the one field that makes a bad night's
   *  extractions attributable to a model change. */
  model?: string | null;
  /** Signal CODES only — `phi-screen.ts` never returns matched text. */
  phiSignals?: string[];
}

/**
 * Record one processed source.
 *
 * 🔴 The recorder is read through `getActivityRecorder()` rather than
 * `recordActivity()`, and the difference matters here. `recordActivity` wraps
 * every emit in `recordSafely`, which swallows a failure so the CALLER's flow
 * is never blocked — right for a chat turn, wrong for a background job, where
 * there is no user-facing flow to protect and a swallowed failure is simply an
 * unaudited write. `cron-runtime`'s `safeRun` wants the throw.
 *
 * Null before `initActivityRecorder` has run, which is the case in unit tests
 * and during early boot; that is a no-op rather than a crash.
 */
export async function recordFilingAudit(args: {
  refs: FilingAuditRefs;
  /** The enabling owner's `User.id`. The row is attributed to `ai` acting on
   *  their behalf, never to a person as though they had done it. */
  ownerId: string;
  severity?: "ok" | "warn";
  what: string;
}): Promise<void> {
  const recorder = getActivityRecorder();
  if (!recorder) {
    logger.debug({ what: args.what }, "filing: no activity recorder bound yet");
    return;
  }

  const refs = pickAllowed(args.refs);
  await recorder.record({
    kind: "system",
    severity: args.severity ?? "ok",
    sourceIcon: "sparkles",
    // 🔴 `what` is a fixed phrase chosen by the CALLER from a closed set, never
    // interpolated with anything read out of a document. See `AUDIT_PHRASES`.
    what: args.what,
    refs,
    actor: { type: "ai", id: args.ownerId },
  });
}

/**
 * The closed set of audit phrases.
 *
 * A fixed string per outcome rather than a template, because the moment a
 * template exists somebody interpolates the filename into it — which is how
 * the indexer bridge came to write `Indexed ${filename}` in the first place.
 */
export const AUDIT_PHRASES = {
  filed: "Read a document and suggested filing",
  nothing: "Read a document and found nothing to file",
  skipped: "Left a document alone",
  failed: "Could not read a document",
  applied: "Filed a suggestion",
  undone: "Undid a filing",
  ruleWritten: "Learned a filing rule",
  ruleRevoked: "Forgot a filing rule",
} as const;

/**
 * Drop anything not on the allow-list, and drop `undefined`s.
 *
 * A filter rather than a type assertion: the type says what SHOULD be here,
 * this says what actually goes out, and only the second one survives a caller
 * spreading an object it did not read carefully.
 */
function pickAllowed(refs: FilingAuditRefs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FILING_AUDIT_REF_KEYS) {
    const value = (refs as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
