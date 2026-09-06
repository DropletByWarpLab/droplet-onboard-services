/**
 * Detector contract (WARP-2749 / WARP-2754, ADR-051).
 *
 * A detector is a DETERMINISTIC query over rows the box already holds. It makes
 * NO model call, and that is a design decision rather than an economy:
 *
 *   - The box runs ONE inference at a time (scheduler `max_concurrent=1`,
 *     provider `num_parallel=1`) and has no turn-level timeout, so anything
 *     that takes the slot can block interactive chat for minutes. A nightly
 *     sweep must never be what is holding it.
 *   - "Is this invoice 90 days overdue" is arithmetic. Asking a 20B model to do
 *     arithmetic over rows you already have is slower, costlier and less
 *     reliable than asking Postgres. The model's job in this feature is
 *     UNDERSTANDING unstructured text (the corpus pass), not counting.
 *
 * Every detector is:
 *   IDEMPOTENT — it returns findings keyed by `subjectKey`, and the runner
 *     upserts on (detectorKey, subjectKey). Running twice writes one row.
 *   EVIDENCED — `evidence.sources` is non-empty or the database rejects it.
 *   SWITCHABLE — one noisy detector is disabled without touching the others.
 *     The realistic failure is not "no findings", it is "300 findings, all from
 *     one detector", after which the operator mutes everything.
 *   HONEST ABOUT IMPACT — `impactMinor`/`currency` are all-or-nothing and
 *     nullable. A detector that cannot compute an impact leaves both null. A
 *     fabricated number is worse than no number.
 */
import type { PrismaClient } from "@prisma/client";
import type { BrainSourceRef } from "../brain-digest.service";

export type DetectedFinding = {
  /** Distinguishes the things this detector found. Combined with `detectorKey`
   *  it forms the dedupe key, so it must be stable across runs for the same
   *  real-world subject — a row id, not a title. */
  subjectKey: string;
  kind: "loss" | "risk" | "inefficiency" | "opportunity" | "inconsistency";
  title: string;
  rationale: string;
  impactMinor?: bigint | null;
  currency?: string | null;
  evidence: { digestIds?: string[]; sources: BrainSourceRef[] };
  confidence?: number | null;
};

export type Detector = {
  /** Stable, closed-alphabet ([a-z0-9._-]) — it is a dedupe-key component. */
  key: string;
  /** One line, shown on /brief next to the detector's findings. */
  description: string;
  /**
   * Returns everything currently true. The runner diffs this against the
   * detector's existing open findings and marks the disappeared ones `stale` —
   * so a paid invoice stops being reported without the detector having to
   * remember what it said last night.
   */
  run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]>;
};
