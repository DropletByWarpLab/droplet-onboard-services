/**
 * WARP-3071 — Kev triage, SHADOW MODE. The first consumer of the decision
 * model (droplet-local-LLM ADR-006; rules in docs/agentic-workflows.md
 * § "Decision model (Kev)").
 *
 * The site: brain finding delivery (brain-notify.service.ts). Every finding
 * gets exactly one rule-based triage verdict there, when `notifiedAt` is
 * stamped — `immediate` (a phone buzz now) or `digest` (batched). This asks
 * Kev the same question about the same text and LOGS both side by side, so the
 * thresholds that would one day let Kev change delivery are measured from real
 * business text, not guessed.
 *
 * Shadow only: nothing here changes what is sent, to whom, or when. It runs
 * after the verdict is final, off the delivery path (fire-and-forget), and
 * every failure is a log line. All Kev calls — across every hook call, so the
 * per-finding immediates and the digest of one pass too — go through ONE
 * serial chain: the sidecar serves one request at a time, and concurrent calls
 * would queue past their timeout and be logged `unavailable` while Kev is
 * healthy, skewing the very data shadow mode exists to collect. Never on the
 * write-approval path. Logs ids, labels, probabilities, latency and status —
 * never the finding's title or rationale.
 */
import type { DecideQuestion, DecideResult } from "../decision-model.client.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("brain-triage-shadow");

/** Today's rule-based verdict, as brain-notify decided it. */
export type TodayTier = "immediate" | "digest";

export type ShadowItem = {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  tier: TodayTier;
};

/** The finding kinds, in the `BrainFindingKind` enum's order. */
const KINDS = ["loss", "risk", "inefficiency", "opportunity", "inconsistency"] as const;

/** A few questions per item: cost scales with the question count. */
export const TRIAGE_QUESTIONS: Record<string, DecideQuestion> = {
  needs_attention_today: {
    type: "noul",
    instructions: "Does the business owner need to look at this today?",
  },
  urgency: {
    type: "score",
    instructions: "How soon does the business owner need to act on this?",
    levels: ["can wait", "this week", "today"],
  },
  category: {
    type: "choice",
    instructions: "What kind of business finding is this?",
    options: KINDS.map((name) => ({ name })),
  },
};

/**
 * Per-call Kev timeout. ADR-006 (droplet-local-LLM) measures up to ~0.9 s per
 * question row on fp32 CPU; 3 questions ≈ 2.7 s, so the 2 s client default
 * would log healthy calls as `unavailable`. Calls are serial, so no queueing.
 */
export const TRIAGE_TIMEOUT_MS = 8000;

type Decide = (args: {
  state: string;
  questions: Record<string, DecideQuestion>;
  timeoutMs?: number;
}) => Promise<DecideResult>;

/**
 * Returns the hook brain-notify calls with each batch of final verdicts, or
 * `undefined` when the flag is off (today's code path, `decide` never called).
 * The hook returns at once; the Kev calls run afterwards, strictly one at a
 * time across all hook calls (one shared chain per shadow).
 */
export function createTriageShadow(opts: {
  enabled: boolean;
  decide: Decide;
}): ((items: ShadowItem[]) => void) | undefined {
  if (!opts.enabled) return undefined;
  const { decide } = opts;
  const run = async (items: ShadowItem[]) => {
    for (const item of items) {
      let result: DecideResult;
      try {
        result = await decide({
          state: `${item.title}\n\n${item.rationale}`,
          questions: TRIAGE_QUESTIONS,
          timeoutMs: TRIAGE_TIMEOUT_MS,
        });
      } catch (e) {
        // `decide` is documented never to throw; a broken injection must not either.
        result = { status: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
      const base = { findingId: item.id, todayTier: item.tier, todayKind: item.kind, status: result.status };
      if (result.status !== "ok") {
        logger.warn({ ...base, detail: result.detail }, "brain.triage_shadow");
        continue;
      }
      logger.info({ ...base, latencyMs: result.latencyMs, model: result.model, kev: result.answers }, "brain.triage_shadow");
    }
  };
  // ponytail: unbounded queue; fine at brain-notify's volume (a handful of
  // findings per pass). Add a cap/drop if a pass can ever emit hundreds.
  let tail: Promise<void> = Promise.resolve();
  return (items) => {
    if (items.length === 0) return;
    tail = tail
      .then(() => run(items))
      .catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "brain.triage_shadow.failed"));
  };
}
