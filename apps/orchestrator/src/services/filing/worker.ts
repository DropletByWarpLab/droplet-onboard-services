/**
 * WARP-2730 (ADR-048) — the loop. One file per tick, claimed durably.
 *
 * ── Why the claim lives on `FileIndexStatus` and not in a queue table ───────
 *
 * The row that already says "new content exists for this path" carries its own
 * claim columns, exactly as WARP-2587 put `notifyStatus` on the activity tables
 * instead of adding an event table. There is no shadow queue to drift from the
 * truth, no backfill to write, and no second thing to reconcile when a file is
 * deleted.
 *
 * ── Why this registration has no `lockKey` ─────────────────────────────────
 *
 * 🔴 A DELIBERATE DEVIATION FROM THE HOUSE PATTERN, and the reason matters.
 * `cron-runtime.service.ts` implements `lockKey` by wrapping the handler in
 * `prisma.$transaction(…, { timeout: 60_000 })` and holding
 * `pg_try_advisory_xact_lock` for the handler's whole duration. That is right
 * for the 23 handlers that use it — they are all short DB sweeps. It is wrong
 * here: a CPU-inference extraction can legitimately outlive 60 s (`completeOnce`
 * allows 120 s for exactly that reason), and a handler that outlives its
 * transaction has every write rolled back while the model keeps running.
 *
 * So the exclusion is done by the CLAIM instead, which is strictly stronger
 * than the cron lock for this job:
 *
 *   - `FOR UPDATE SKIP LOCKED` + a guarded `updateMany` is atomic across
 *     replicas, which is what the advisory lock was buying;
 *   - unlike the advisory lock it SURVIVES A RESTART — a process killed
 *     mid-extraction leaves a `running` row with an `extractClaimedAt`, and
 *     `reconcile.ts` re-arms it. An advisory lock simply vanishes, and the row
 *     it was protecting would sit `running` forever.
 *
 * `safeRun` still supervises the handler (the failure counter and the canary
 * are on `scheduleInterval`, not on `lockKey`), so nothing about error
 * reporting changes. The module-level `inFlight` flag below stops a slow model
 * stacking ticks within one process.
 *
 * ── The two traps this slice must not fall into ────────────────────────────
 *
 * 1. `set_index_status` bumps `updatedAt` on EVERY upsert, including a
 *    metadata-only touch. A `chown -R`, a restic restore, a desktop resync or
 *    an `occ files:scan` would otherwise re-extract the entire corpus. The
 *    fingerprint is compared before any model call — see `read-content.ts`.
 * 2. A file modified WHILE the worker holds the claim must still re-arm. The
 *    watermark written at the end is the `updatedAt` SNAPSHOTTED AT CLAIM TIME,
 *    never `now()`: writing `now()` would overtake the bump and that file could
 *    never be read again.
 */
import type { PrismaClient, ExtractStatus, ExtractReason } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import { extractFromText, resolveFilingModel, type ExtractFailureReason } from "./extract.js";
import { readFileContent } from "./read-content.js";
import { buildDrafts, persistDrafts, prismaMatcher } from "./propose.js";
import { isInScope, permittedOwnerIds, readFilingSettings } from "./settings.js";

const logger = createLogger("filing-worker");

/** Attempts before a row is left terminal `failed`. Three, because the two
 *  failures worth retrying (a cold model, a transient gateway blip) clear on
 *  the second try and a third is evidence rather than hope. */
export const MAX_ATTEMPTS = 3;

/** Nothing on this box has a `fileSpace` concept per row, and `EntityLink`
 *  requires one. Files claimed here are in the owner's own space or the
 *  household share; both browse as `files`. */
const DEFAULT_FILE_SPACE = "files";

export type TickOutcome =
  | { status: "idle"; reason: "off" | "no_owner" | "nothing_pending" | "in_flight" }
  | { status: "blocked"; reason: "model_unreachable" | "cloud_model_refused"; detail?: string }
  | {
      status: "processed";
      path: string;
      extractStatus: ExtractStatus;
      extractReason: ExtractReason | null;
      proposalsCreated: number;
    };

interface ClaimRow {
  userId: string;
  path: string;
  ncFileId: number;
  updatedAt: Date;
  extractFingerprint: string | null;
}

let inFlight = false;

/**
 * The reason → status map, written once.
 *
 * `skipped` is a DECISION ("we looked and chose not to file this"), `failed` is
 * a PROBLEM ("we could not"), `not_needed` is an ABSENCE ("there was nothing to
 * do"), and `done` is success. Keeping them distinct is what lets the Skipped
 * tab be a short list an owner actually reads instead of a mixed bin.
 */
const STATUS_FOR: Record<ExtractFailureReason | "unchanged" | "no_text" | "encrypted_content", ExtractStatus> = {
  phi_path: "skipped",
  phi_record: "skipped",
  not_business: "skipped",
  bad_json: "failed",
  model_unreachable: "failed",
  cloud_model_refused: "failed",
  unchanged: "done",
  no_text: "not_needed",
  encrypted_content: "not_needed",
};

/** Failures worth another go. A PHI verdict is not one of them — it will not
 *  come out differently, and re-asking a model about a patient record is the
 *  opposite of what the screen is for. */
const RETRYABLE: ReadonlySet<string> = new Set(["bad_json", "model_unreachable"]);

/**
 * One tick.
 *
 * Returns rather than throws for every expected outcome, so the cron canary
 * counts real faults. A genuine fault (the database is gone) propagates naked
 * to `safeRun`, matching every other handler in `index.ts`.
 */
export async function runFilingTick(prisma: PrismaClient): Promise<TickOutcome> {
  if (inFlight) return { status: "idle", reason: "in_flight" };

  const settings = await readFilingSettings(prisma);
  if (settings.mode === "off") return { status: "idle", reason: "off" };

  const owners = await permittedOwnerIds(prisma, settings);
  if (owners.length === 0 || !settings.enabledById) {
    return { status: "idle", reason: "no_owner" };
  }

  // Resolved BEFORE anything is claimed. A box pointed at a cloud model has
  // nothing wrong with its FILES, so no file is marked `failed` for it — the
  // tick reports the block and the row stays pending, ready for the moment the
  // owner points the box back at a local model. Marking the corpus instead
  // would turn a one-line settings mistake into thousands of rows to re-arm.
  const model = await resolveFilingModel(prisma);
  if (!model.ok) {
    logger.warn({ reason: model.reason, detail: model.detail }, "filing: no usable local model");
    return { status: "blocked", reason: model.reason, detail: model.detail };
  }

  inFlight = true;
  try {
    const claim = await claimOne(prisma, owners, settings.enabledAt);
    if (!claim) return { status: "idle", reason: "nothing_pending" };

    return await processClaim(prisma, claim, settings, model.model);
  } finally {
    inFlight = false;
  }
}

/**
 * Claim one row.
 *
 * The predicate is the whole re-arm design in four lines: a `pending` row is
 * new, and a `done` row whose watermark is behind its `updatedAt` has been
 * touched since we last read it. `skipped` and `not_needed` deliberately do NOT
 * re-arm on a touch — a PHI skip is sticky, and re-asking on every `chown` is
 * the loop this design exists to avoid. `failed` re-arms through
 * `reconcile.ts`, which owns the attempt budget.
 */
async function claimOne(
  prisma: PrismaClient,
  owners: string[],
  enabledAt: Date | null,
): Promise<ClaimRow | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT "userId", "path", "ncFileId", "updatedAt", "extractFingerprint"
      FROM "FileIndexStatus"
      WHERE "status" = 'ready'
        AND "ncFileId" IS NOT NULL
        AND "userId" = ANY(${owners})
        AND ("updatedAt" >= ${enabledAt ?? new Date(0)})
        AND (
          "extractStatus" = 'pending'
          OR (
            "extractStatus" = 'done'
            AND "extractedFromUpdatedAt" IS NOT NULL
            AND "extractedFromUpdatedAt" < "updatedAt"
          )
        )
      ORDER BY "updatedAt" DESC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    const claimed = await tx.fileIndexStatus.updateMany({
      where: {
        userId: row.userId,
        path: row.path,
        extractStatus: { in: ["pending", "done"] },
      },
      data: {
        extractStatus: "running",
        extractClaimedAt: new Date(),
        extractAttempts: { increment: 1 },
        // `FileIndexStatus_extract_terminal` ties a terminal timestamp to a
        // terminal status in BOTH directions, so re-claiming a `done` row has
        // to clear it or the UPDATE is refused.
        extractedAt: null,
        extractReason: null,
      },
    });
    // 🔴 The race arm. `updateMany` takes no `take` and no `orderBy`, so the
    // guard is the count: another replica that won the row leaves us at zero.
    return claimed.count === 1 ? row : null;
  });
}

async function processClaim(
  prisma: PrismaClient,
  claim: ClaimRow,
  settings: Awaited<ReturnType<typeof readFilingSettings>>,
  model: string,
): Promise<TickOutcome> {
  const finish = (
    extractStatus: ExtractStatus,
    reason: ExtractReason | null,
    fingerprint: string | null,
    proposalsCreated = 0,
  ) => complete(prisma, claim, extractStatus, reason, fingerprint, proposalsCreated);

  if (!isInScope(claim.path, settings.folders)) {
    return finish("not_needed", "out_of_scope", null);
  }

  const owners = await permittedOwnerIds(prisma, settings);
  const read = await readFileContent(prisma, claim.ncFileId, owners);
  if (!read.ok) {
    return finish(STATUS_FOR[read.reason], read.reason, null);
  }

  // 🔴 Before any model call. `updatedAt` moves on a touch, not on a change.
  if (claim.extractFingerprint && claim.extractFingerprint === read.content.fingerprint) {
    return finish("done", "unchanged", read.content.fingerprint);
  }

  const outcome = await extractFromText({
    model,
    storedPath: claim.path,
    text: read.content.text,
    denylist: settings.pathDenylist,
  });

  if (!outcome.ok) {
    const status = STATUS_FOR[outcome.reason];
    // A retryable failure goes back to `pending` while it still has budget, so
    // the next tick tries again rather than a sweep having to notice.
    if (status === "failed" && RETRYABLE.has(outcome.reason)) {
      const attempts = await currentAttempts(prisma, claim);
      if (attempts < MAX_ATTEMPTS) {
        await prisma.fileIndexStatus.updateMany({
          where: { userId: claim.userId, path: claim.path, extractStatus: "running" },
          data: { extractStatus: "pending", extractClaimedAt: null },
        });
        return {
          status: "processed",
          path: claim.path,
          extractStatus: "pending",
          extractReason: null,
          proposalsCreated: 0,
        };
      }
    }
    return finish(status, outcome.reason, read.content.fingerprint);
  }

  const { drafts, ignored } = await buildDrafts({
    source: {
      sourceKind: "FILE",
      sourceRef: `file:${claim.ncFileId}`,
      ncFileId: claim.ncFileId,
      filePath: claim.path,
      fileSpace: DEFAULT_FILE_SPACE,
    },
    entities: outcome.result.entities,
    phiVerdict: outcome.result.phiVerdict,
    settings,
    resolveMatch: prismaMatcher(prisma),
  });

  if (ignored) return finish("not_needed", "ignored_by_you", read.content.fingerprint);

  const persisted = await persistDrafts(
    prisma,
    {
      sourceKind: "FILE",
      sourceRef: `file:${claim.ncFileId}`,
      ncFileId: claim.ncFileId,
      filePath: claim.path,
      fileSpace: DEFAULT_FILE_SPACE,
    },
    drafts,
    { requestedById: settings.enabledById!, phiVerdict: outcome.result.phiVerdict },
  );

  logger.info(
    {
      ncFileId: claim.ncFileId,
      phiVerdict: outcome.result.phiVerdict,
      created: persisted.created,
      duplicate: persisted.duplicate,
      droppedUnverified: outcome.result.droppedUnverified,
      droppedPhi: outcome.result.droppedPhi,
    },
    // No path and no filename. Filenames are PHI (WARP-1983) and this line
    // goes to a log that is read by more people than the CRM is.
    "filing: extracted",
  );

  return finish("done", null, read.content.fingerprint, persisted.created);
}

async function currentAttempts(prisma: PrismaClient, claim: ClaimRow): Promise<number> {
  const row = await prisma.fileIndexStatus.findUnique({
    where: { userId_path: { userId: claim.userId, path: claim.path } },
    select: { extractAttempts: true },
  });
  return row?.extractAttempts ?? MAX_ATTEMPTS;
}

/**
 * Write the terminal state.
 *
 * 🔴 `extractedFromUpdatedAt` is the value snapshotted AT CLAIM TIME, not
 * `now()`. If the file was modified while we held the claim, its `updatedAt` is
 * now ahead of this watermark and the claim predicate picks it up again. Using
 * `now()` here would overtake that bump and the file could never be read again
 * — the failure would look exactly like "the model found nothing".
 */
async function complete(
  prisma: PrismaClient,
  claim: ClaimRow,
  extractStatus: ExtractStatus,
  extractReason: ExtractReason | null,
  fingerprint: string | null,
  proposalsCreated: number,
): Promise<TickOutcome> {
  await prisma.fileIndexStatus.updateMany({
    where: { userId: claim.userId, path: claim.path, extractStatus: "running" },
    data: {
      extractStatus,
      extractReason,
      extractedAt: new Date(),
      extractedFromUpdatedAt: claim.updatedAt,
      extractClaimedAt: null,
      ...(fingerprint ? { extractFingerprint: fingerprint } : {}),
    },
  });
  return {
    status: "processed",
    path: claim.path,
    extractStatus,
    extractReason,
    proposalsCreated,
  };
}

/** Test seam: the in-flight flag is module state, and a test that leaves it
 *  set would silently turn every later tick into a no-op. */
export function __resetInFlightForTests(): void {
  inFlight = false;
}
