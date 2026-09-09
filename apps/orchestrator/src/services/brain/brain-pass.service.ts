/**
 * Brain pass runner (WARP-2749, ADR-051) — the thing that runs overnight and
 * updates the saved state, so a question never triggers a scan.
 *
 * TWO PASSES, ONE CLOCK.
 *
 *   `detectors`        deterministic queries over landed rows. No model call at
 *                      all: the box runs ONE inference at a time and has no
 *                      turn-level timeout, so a sweep must never hold the slot.
 *                      "Is this invoice 90 days overdue" is arithmetic, and
 *                      Postgres is better at it than a 20B model.
 *   `corpus.documents` the LLM pass, cursored over changed files. Bounded per
 *                      run and yielding between units — see
 *                      `brain-corpus.service.ts`.
 *
 * Both are registered on `cronRuntime` with advisory locks, alongside every
 * other tick. There is exactly one scheduler in this repo and a guard test pins
 * that; this adds no second one.
 *
 * THE STALENESS SWEEP IS THE PART THAT MAKES IT LIVEABLE. A detector returns
 * everything currently true. The runner diffs that against the detector's own
 * OPEN findings and marks the disappeared ones `stale`. So when an invoice is
 * paid, its finding stops being reported on the next pass — the detector never
 * has to remember what it said last night, and nobody has to dismiss a finding
 * that fixed itself. Without this, /brief accumulates resolved problems and
 * becomes a list nobody reads.
 *
 * WHAT IS DELIBERATELY NOT SWEPT: `dismissed` and `actioned` rows. A human's
 * decision is not the runner's to revise, in either direction — it neither
 * resurrects them (see `upsertFinding`) nor re-stales them.
 */
import type { PrismaClient } from "@prisma/client";
import { DETECTORS, type Detector } from "./detectors";
import { upsertFinding } from "./brain-digest.service";
import { CORPUS_PASS_KEY } from "./brain-corpus.service";

export const DETECTOR_PASS_KEY = "detectors";
// 🔴 WARP-2850 — `BRAIN_PASS_LOCK_KEY` USED TO LIVE HERE AND IS GONE ON
// PURPOSE, for the reason WARP-2837 removed the corpus one: cron-runtime's
// `lockKey` runs the handler inside a 60 s `$transaction`, and both brain
// passes now take the lease in brain-lease.service.ts instead. The detector
// pass would probably have fitted in sixty seconds — but two passes with two
// different exclusion mechanisms is two answers to "is this pass running",
// which is exactly the shape of defect this epic keeps finding. One answer,
// for every caller: the tick, the boot run and the operator's "check now".
//
// Deleted rather than left unused: an exported lock key beside a pass is an
// invitation to hand it to `scheduleInterval`.

/**
 * EVERY pass this box runs, and the only list of them.
 *
 * 🔴 WARP-2837 — THE CORPUS KEY IS LOAD-BEARING HERE, and leaving it out was a
 * fresh-install boot deadlock. Until the lease landed, the corpus row was
 * self-created by `runCorpusPass`'s own upsert on tick 1, so seeding only the
 * detector row was survivable. The lease inverted that: the tick now claims
 * BEFORE it runs, and `claimPass` is a conditional `updateMany` — it matches
 * zero rows when the row does not exist, so the run that would have created it
 * never happens. A genuinely fresh box would have failed every corpus tick with
 * `reason: "missing"`, at `debug`, forever, with nothing in the system able to
 * un-wedge it.
 *
 * The rule that falls out: a pass that takes the lease MUST be seeded here.
 * Nothing downstream of the claim can bootstrap its own row any more.
 */
export const BRAIN_PASS_KEYS = [DETECTOR_PASS_KEY, CORPUS_PASS_KEY] as const;

/** Statuses a pass may transition to `stale`. A human's decision (`dismissed`,
 *  `actioned`) is left exactly where they put it. */
const SWEEPABLE = ["new", "acknowledged"] as const;

export type PassOutcome = {
  passKey: string;
  ran: boolean;
  found: number;
  written: number;
  staled: number;
  errors: string[];
};

/**
 * Run every detector once and reconcile the results.
 *
 * Never throws for a single detector's failure: one bad detector must not stop
 * the others from reporting, and the operator needs to know WHICH one broke.
 * Errors are collected, recorded on the pass row, and returned.
 */
export async function runDetectorPass(
  prisma: PrismaClient,
  opts: { now?: Date; detectors?: readonly Detector[] } = {},
): Promise<PassOutcome> {
  const now = opts.now ?? new Date();
  const detectors = opts.detectors ?? DETECTORS;

  const pass = await prisma.brainPass.upsert({
    where: { passKey: DETECTOR_PASS_KEY },
    create: { passKey: DETECTOR_PASS_KEY },
    update: {},
    select: { enabled: true },
  });
  if (!pass.enabled) {
    return { passKey: DETECTOR_PASS_KEY, ran: false, found: 0, written: 0, staled: 0, errors: [] };
  }

  let found = 0;
  let written = 0;
  let staled = 0;
  const errors: string[] = [];

  for (const detector of detectors) {
    try {
      const results = await detector.run(prisma, now);
      found += results.length;

      const seen = new Set<string>();
      for (const r of results) {
        seen.add(r.subjectKey);
        await upsertFinding(prisma, {
          kind: r.kind,
          title: r.title,
          rationale: r.rationale,
          impactMinor: r.impactMinor ?? null,
          currency: r.currency ?? null,
          evidence: r.evidence,
          confidence: r.confidence ?? null,
          detectorKey: detector.key,
          subjectKey: r.subjectKey,
          // COMPANY scope, not personal. Every detector reads business-shared
          // rows — `ErpDocument`, `CrmDeal` — which the CRM/ERP surfaces treat
          // as household-shared with no per-user scoping. Labelling their
          // output `personal` would have been a lie in both directions: it has
          // no single owner to attribute it to, and /brief is owner/admin-only
          // anyway, which is exactly who `company` admits.
          scope: "company",
        });
        written += 1;
      }

      // The sweep. Anything this detector previously raised and did NOT raise
      // now has resolved itself; say so rather than leaving it on the list.
      //
      // The subject is recovered from the dedupeKey the writer built:
      // `${detectorKey}:finding:-:${subjectKey}`. `detectorKey` has a closed
      // alphabet with no ":" and the two middle slots are fixed, so everything
      // from index 3 on is the subject — rejoined rather than indexed, so a
      // subject containing ":" survives the round trip.
      const open = await prisma.brainFinding.findMany({
        where: { detectorKey: detector.key, status: { in: [...SWEEPABLE] } },
        select: { id: true, dedupeKey: true },
      });
      const gone = open.filter(
        (row) => !seen.has(row.dedupeKey.split(":").slice(3).join(":")),
      );
      if (gone.length > 0) {
        const res = await prisma.brainFinding.updateMany({
          where: { id: { in: gone.map((g) => g.id) } },
          data: { status: "stale" },
        });
        staled += res.count;
      }
    } catch (err) {
      errors.push(`${detector.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await prisma.brainPass.update({
    where: { passKey: DETECTOR_PASS_KEY },
    data: {
      lastRunAt: now,
      // Only a clean run counts as a success; a partial one leaves the previous
      // success timestamp alone so a freshness check cannot be fooled.
      ...(errors.length === 0 ? { lastSucceededAt: now, lastError: null } : {}),
      ...(errors.length > 0 ? { lastError: errors.join(" | ").slice(0, 1000) } : {}),
      unitsSeen: { increment: detectors.length },
      unitsDigested: { increment: detectors.length - errors.length },
      rowsWritten: { increment: written },
    },
  });

  return { passKey: DETECTOR_PASS_KEY, ran: true, found, written, staled, errors };
}

/**
 * Seed the pass rows. Called from `app.ts` boot — NOT from `prisma/seed.ts`.
 *
 * That distinction is the whole point of this function. `seedDailyReportSpec`
 * has exactly one non-test caller, `prisma/seed.ts:70`, and `prisma/seed.ts` is
 * invoked NOWHERE in `scripts/` or `docker/` — only `docker/dev/` runs
 * `seed.dev.ts`. So on a shipped box the daily-report spec does not exist and
 * its /reports button 404s. A brain seeded the same way would silently never
 * run, and nobody would find out until they asked why /brief was empty.
 */
export async function seedBrainPasses(prisma: PrismaClient): Promise<void> {
  for (const passKey of BRAIN_PASS_KEYS) {
    await prisma.brainPass.upsert({
      where: { passKey },
      create: { passKey },
      // Deliberately empty: never re-enable a pass an operator switched off.
      update: {},
    });
  }
}
