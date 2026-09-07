/**
 * Brain digest/finding service (WARP-2748, ADR-051 slice 1) -- the data layer
 * behind the standing, derived understanding of the business.
 *
 * WHAT THIS IS FOR. A question cannot scan the company. The shipped context
 * window is 16,384 tokens; a turn spends ~2,950 on fixed blocks and ~3,426 on
 * tool schemas before the user types, every tool result is capped at 8,000
 * chars by a Zod `.max(8000)` an operator cannot raise, and the agent loop
 * force-finalizes past 13,824 estimated tokens. That is ~40-45 KB of readable
 * text per turn against a corpus five orders of magnitude larger. So a
 * scheduled pass reads a little at a time and writes rows here, and a question
 * reads the rows. The intelligence moves off the query path.
 *
 * IDEMPOTENCY IS THE POINT. Every write goes through `dedupeKey`, a NOT NULL
 * derived column with a real unique index, so the same overdue invoice on
 * Tuesday UPDATES Monday's row. `EntityLink` shows what the alternative costs:
 * a compound unique over nullable subject columns constrains NOTHING (Postgres
 * never treats two rows as duplicates when an indexed column is NULL), and the
 * five partial indexes it fell back on cannot be addressed by `prisma.upsert`,
 * forcing an updateMany-then-create retry at every call site. One derived
 * column keeps `upsert` usable, which is exactly what a nightly loop needs.
 *
 * PROVENANCE IS ENFORCED IN THE DATABASE, NOT HERE. `BrainDigest_sources_not_empty`
 * and `BrainFinding_evidence_not_empty` are CHECK constraints. This service
 * validates too -- so callers get a clean error code instead of a raw Postgres
 * violation -- but the constraint is the backstop that a detector with a bug
 * cannot talk its way past. A row nobody can trace to a source is a
 * hallucination with a row id: it reads as fact, survives restarts, and gets
 * prompt-injected into later turns.
 *
 * VISIBILITY. `scope` records the corpus a row was derived FROM, which bounds
 * who may read it. The department arm reuses `readableDepartmentIdsFor`
 * (middleware/space.ts) rather than reimplementing membership -- the same
 * helper `routes/files.ts` and `entity-link.service.ts` run, including its
 * audited owner/admin see-all bypass. Rows are filtered OUT, never 403'd, and
 * a reported total is the POST-FILTER count: a total that counted hidden rows
 * would leak exactly the existence the filter exists to hide
 * (`entity-link.service.ts` ruling).
 *
 * Errors are thrown as plain `Error(code)` with stable string codes the route
 * layer maps to HTTP status, mirroring `crm.service.ts`.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import { readableDepartmentIdsFor } from "../../middleware/space";
import type { SpaceAccessCaller } from "../../middleware/space";

/** Widest list a single read returns. The prompt-injected block is bounded
 *  separately and much lower; this is the API ceiling. */
export const DIGEST_LIST_CAP = 200;
export const FINDING_LIST_CAP = 200;

/** `detectorKey` is a component of `dedupeKey`, which is built by joining with
 *  ":". A key containing the separator could collide two different detectors
 *  onto one row, so the alphabet is closed rather than trusted. */
const DETECTOR_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type BrainSourceRef = {
  /** Where the claim came from: "file" | "email" | "team_chat" | "crm" | ... */
  sourceKind: string;
  /** Identity within that pocket. `ncFileId` as a string for files -- the
   *  oc:fileid ruling `FileComment` made and `EntityLink` follows. */
  sourceId: string;
  /** The span that supports the claim. This is what makes a digest auditable
   *  rather than merely attributed: a reviewer can check the row without
   *  re-running the model. */
  quote: string;
};

export type UpsertDigestInput = {
  kind: "entity" | "project" | "obligation" | "theme" | "metric" | "relationship";
  title: string;
  body: string;
  subjectType?:
    | "COMPANY" | "CONTACT" | "DEAL" | "PROJECT" | "WORK_ITEM" | "DOCUMENT" | "FILE"
    | null;
  subjectId?: string | null;
  sources: BrainSourceRef[];
  confidence?: number | null;
  scope?: "personal" | "department" | "company";
  departmentId?: string | null;
  /** REQUIRED when scope is `personal` — the local `User.id` whose space this
   *  was derived from. See the `ownerId` docstring in schema.prisma. */
  ownerId?: string | null;
  detectorKey: string;
};

export type UpsertFindingInput = {
  kind: "loss" | "risk" | "inefficiency" | "opportunity" | "inconsistency";
  title: string;
  rationale: string;
  impactMinor?: bigint | null;
  currency?: string | null;
  evidence: { digestIds?: string[]; sources: BrainSourceRef[] };
  confidence?: number | null;
  scope?: "personal" | "department" | "company";
  departmentId?: string | null;
  /** REQUIRED when scope is `personal`. */
  ownerId?: string | null;
  detectorKey: string;
  /** Distinguishes findings the same detector raises about different things.
   *  Omit for a detector that produces at most one finding overall. */
  subjectKey?: string | null;
};

/**
 * The idempotency key. Readable rather than hashed, on purpose: when a nightly
 * pass produces a surprising row, the key itself says which detector made it
 * and about what, without a join or a lookup table. All components are bounded
 * (an enum, a closed-alphabet detector key, a UUID), so the result is too.
 */
export function brainDedupeKey(parts: {
  detectorKey: string;
  kind: string;
  subjectType?: string | null;
  subjectId?: string | null;
}): string {
  assertDetectorKey(parts.detectorKey);
  // "-" for absent rather than "" so that (subjectType=null, subjectId="x")
  // and (subjectType="x", subjectId=null) cannot collapse to the same key.
  const subjectType = parts.subjectType ?? "-";
  const subjectId = parts.subjectId ?? "-";
  return `${parts.detectorKey}:${parts.kind}:${subjectType}:${subjectId}`;
}

function assertDetectorKey(detectorKey: string): void {
  if (!DETECTOR_KEY_RE.test(detectorKey)) throw new Error("invalid_detector_key");
}

/** Shared shape validation. Throws the stable codes the routes map. */
function assertSources(sources: BrainSourceRef[] | undefined): void {
  // Mirrors the DB CHECK. Validated here as well so a caller gets
  // `evidence_required` rather than a raw constraint-violation string.
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("evidence_required");
  for (const s of sources) {
    if (!s || typeof s.sourceKind !== "string" || !s.sourceKind.trim())
      throw new Error("evidence_required");
    if (typeof s.sourceId !== "string" || !s.sourceId.trim())
      throw new Error("evidence_required");
    if (typeof s.quote !== "string" || !s.quote.trim())
      throw new Error("evidence_required");
  }
}

function assertConfidence(confidence: number | null | undefined): void {
  if (confidence === null || confidence === undefined) return;
  // Integer 0-100, matching EntityLink.confidence and
  // CrmPipelineStage.probability. A 0..1 float arriving here is a caller that
  // guessed the scale, and silently accepting 0.85 as "0%" is worse than a 400.
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)
    throw new Error("confidence_out_of_range");
}

/** Each scope names the thing that bounds it, and only that scope may.
 *  Mirrors the `*_department_scope_needs_id` and `*_personal_scope_needs_owner`
 *  CHECKs — validated here too so a caller gets a stable code instead of a raw
 *  constraint violation. */
function assertScopeShape(
  scope: "personal" | "department" | "company",
  departmentId: string | null | undefined,
  ownerId: string | null | undefined,
): void {
  const hasDept = departmentId !== null && departmentId !== undefined;
  if ((scope === "department") !== hasDept) throw new Error("scope_department_mismatch");
  const hasOwner = typeof ownerId === "string" && ownerId.length > 0;
  if ((scope === "personal") !== hasOwner) throw new Error("scope_owner_mismatch");
}

/**
 * Write a digest, or confirm the one already there.
 *
 * A re-run over unchanged input is not a no-op: it advances `lastConfirmedAt`,
 * which is how "still true as of last night" is distinguished from "nobody has
 * looked at this since March". `firstSeenAt` is never moved -- that is the
 * accumulation record.
 */
export async function upsertDigest(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: UpsertDigestInput,
): Promise<{ id: string; created: boolean }> {
  assertSources(input.sources);
  assertConfidence(input.confidence);
  const scope = input.scope ?? "personal";
  assertScopeShape(scope, input.departmentId, input.ownerId);

  const dedupeKey = brainDedupeKey({
    detectorKey: input.detectorKey,
    kind: input.kind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });

  const now = new Date();
  const existing = await prisma.brainDigest.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });

  const shared = {
    kind: input.kind,
    title: input.title,
    body: input.body,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    sources: input.sources as unknown as Prisma.InputJsonValue,
    confidence: input.confidence ?? null,
    scope,
    departmentId: input.departmentId ?? null,
    ownerId: input.ownerId ?? null,
    detectorKey: input.detectorKey,
    lastConfirmedAt: now,
  };

  const row = await prisma.brainDigest.upsert({
    where: { dedupeKey },
    // firstSeenAt is set by the column default on create and deliberately
    // absent from the update branch: a confirmed row keeps the date it was
    // first learned.
    create: { ...shared, dedupeKey },
    update: shared,
    select: { id: true },
  });

  return { id: row.id, created: existing === null };
}

/**
 * Write a finding, or confirm the one already there.
 *
 * DELIBERATELY DOES NOT RESURRECT A DISMISSAL. If a human dismissed this
 * finding, a later pass that still sees the condition must not flip it back to
 * `new` -- that is the loop arguing with the operator, and it is how a nightly
 * feature earns a mute. The row's `lastConfirmedAt` still advances so the
 * condition is known to persist; the status stays where the human put it.
 */
export async function upsertFinding(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: UpsertFindingInput,
): Promise<{ id: string; created: boolean; statusPreserved: boolean }> {
  assertSources(input.evidence?.sources);
  assertConfidence(input.confidence);
  const scope = input.scope ?? "personal";
  assertScopeShape(scope, input.departmentId, input.ownerId);

  // All-or-nothing, mirroring BrainFinding_impact_needs_currency. A detector
  // that cannot compute an impact leaves BOTH null rather than guessing: a
  // fabricated number is worse than no number.
  const hasImpact = input.impactMinor !== null && input.impactMinor !== undefined;
  const hasCurrency = input.currency !== null && input.currency !== undefined;
  if (hasImpact !== hasCurrency) throw new Error("impact_needs_currency");

  // NOTE the literal "finding" where a digest passes its `kind`. A finding is
  // identified by (detector, subject) and NOT by kind, because `kind` is a
  // mutable judgement: a slipping deal that is reclassified `risk` -> `loss`
  // must UPDATE its row, not orphan it and create a second one that the
  // staleness sweep would then never retire. Digests key on `kind` because
  // there a different kind genuinely is a different claim about the subject.
  const dedupeKey = brainDedupeKey({
    detectorKey: input.detectorKey,
    kind: "finding",
    subjectType: null,
    subjectId: input.subjectKey ?? null,
  });

  const now = new Date();
  const existing = await prisma.brainFinding.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true },
  });

  const shared = {
    kind: input.kind,
    title: input.title,
    rationale: input.rationale,
    impactMinor: input.impactMinor ?? null,
    currency: input.currency ?? null,
    evidence: input.evidence as unknown as Prisma.InputJsonValue,
    confidence: input.confidence ?? null,
    scope,
    departmentId: input.departmentId ?? null,
    ownerId: input.ownerId ?? null,
    detectorKey: input.detectorKey,
    lastConfirmedAt: now,
  };

  const row = await prisma.brainFinding.upsert({
    where: { dedupeKey },
    create: { ...shared, dedupeKey },
    // No `status` in the update branch -- see the docstring. A human's
    // decision outranks a later pass that still sees the condition.
    update: shared,
    select: { id: true },
  });

  // `stale` was set by the SWEEP, not by a human: it means "the detector
  // stopped reporting this". The detector is reporting it again, so the row is
  // OPEN again. Without this a condition that resolves and recurs — an invoice
  // paid, then overdue a second time — is invisible forever, because /brief and
  // the notifier both read `status: "new"` only.
  //
  // `dismissed` and `actioned` are a person's decision and are NOT touched. The
  // guard lives in the WHERE rather than in a branch on the read above, so it
  // is one atomic UPDATE: a human dismissing between the two statements still
  // wins, and this is not the findUnique -> check -> update shape the repo's own
  // review-patterns skill lists as a caught anti-pattern.
  //
  // `notifiedAt` clears with it. Announce-once is about a condition that never
  // went away; one that RESOLVED and came back is a new event and deserves to
  // be told again.
  let revived = 0;
  if (existing?.status === "stale") {
    const res = await prisma.brainFinding.updateMany({
      where: { dedupeKey, status: "stale" },
      data: { status: "new", notifiedAt: null },
    });
    revived = res.count;
  }

  return {
    id: row.id,
    created: existing === null,
    // `revived === 0` so this stops claiming a preservation that did not happen.
    statusPreserved: existing !== null && existing.status !== "new" && revived === 0,
  };
}

/**
 * The scope filter every read composes. Returns a Prisma `OR` a caller drops
 * into its own `where`.
 *
 * `personal` is included for every role: a personal-scope row was derived from
 * the reader's own space in the first place. `company` is owner/admin only --
 * that is the ADR-051 privacy line, and it is enforced here rather than at the
 * route because the corpus that produced the row is the only thing that knows
 * how wide it was.
 */
export async function visibleScopeFilter(
  prisma: PrismaClient,
  caller: SpaceAccessCaller,
): Promise<Prisma.BrainDigestWhereInput> {
  const privileged = caller.role === "owner" || caller.role === "admin";
  const deptIds = [...(await readableDepartmentIdsFor(prisma, caller))];

  // SCOPED TO THE CALLER. An unqualified `{ scope: "personal" }` was a
  // cross-user leak: neither table had an owner column, so every authenticated
  // reader saw every other person's personal rows. `ownerId` is now required
  // for that scope by a CHECK, and this is the half that reads it back.
  const or: Prisma.BrainDigestWhereInput[] = [{ scope: "personal", ownerId: caller.id }];
  if (deptIds.length > 0) or.push({ scope: "department", departmentId: { in: deptIds } });
  if (privileged) or.push({ scope: "company" });

  return { OR: or };
}

export async function listDigests(
  prisma: PrismaClient,
  caller: SpaceAccessCaller,
  opts: { kind?: UpsertDigestInput["kind"]; limit?: number } = {},
): Promise<{ rows: Awaited<ReturnType<typeof prisma.brainDigest.findMany>>; total: number }> {
  const scopeFilter = await visibleScopeFilter(prisma, caller);
  const where: Prisma.BrainDigestWhereInput = {
    ...scopeFilter,
    // A superseded row is history, not current understanding. It is kept so
    // the reason a claim changed stays readable, and excluded from reads.
    supersededById: null,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };

  const take = Math.min(Math.max(1, opts.limit ?? 50), DIGEST_LIST_CAP);
  // POST-FILTER count: the filter is part of `where`, so this total can never
  // report rows the caller may not see.
  const [rows, total] = await Promise.all([
    prisma.brainDigest.findMany({ where, orderBy: { lastConfirmedAt: "desc" }, take }),
    prisma.brainDigest.count({ where }),
  ]);
  return { rows, total };
}

export async function listFindings(
  prisma: PrismaClient,
  caller: SpaceAccessCaller,
  opts: {
    status?: "new" | "acknowledged" | "actioned" | "dismissed" | "stale";
    kind?: UpsertFindingInput["kind"];
    limit?: number;
  } = {},
): Promise<{ rows: Awaited<ReturnType<typeof prisma.brainFinding.findMany>>; total: number }> {
  const scopeFilter = (await visibleScopeFilter(
    prisma,
    caller,
  )) as Prisma.BrainFindingWhereInput;
  const where: Prisma.BrainFindingWhereInput = {
    ...scopeFilter,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  };

  const take = Math.min(Math.max(1, opts.limit ?? 50), FINDING_LIST_CAP);
  const [rows, total] = await Promise.all([
    prisma.brainFinding.findMany({
      where,
      // Open work, biggest money first. `impactMinor` is nullable and Postgres
      // sorts NULLs first on DESC, so they are pushed last explicitly --
      // otherwise every impact-less finding outranks a $40k one.
      orderBy: [{ impactMinor: { sort: "desc", nulls: "last" } }, { lastConfirmedAt: "desc" }],
      take,
    }),
    prisma.brainFinding.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Move a finding's status. `dismissed` requires a reason -- mirroring
 * `BrainFinding_dismissed_needs_reason`, and for the reason the constraint
 * gives: a dismissal with no reason is indistinguishable from a detector bug,
 * and the reason is what lets the next pass tell "a human decided this is
 * fine" from "nobody has looked".
 */
export async function setFindingStatus(
  prisma: PrismaClient,
  caller: SpaceAccessCaller,
  id: string,
  next: {
    status: "new" | "acknowledged" | "actioned" | "dismissed" | "stale";
    dismissedReason?: string | null;
    assigneeId?: string | null;
  },
): Promise<void> {
  if (next.status === "dismissed" && !next.dismissedReason?.trim())
    throw new Error("dismissal_needs_reason");

  // Re-check visibility on the write path. A caller who cannot READ a finding
  // must not be able to dismiss it by guessing its id -- the filter on the
  // list route is not an authorization check for this one.
  const scopeFilter = (await visibleScopeFilter(
    prisma,
    caller,
  )) as Prisma.BrainFindingWhereInput;
  const visible = await prisma.brainFinding.findFirst({
    where: { AND: [{ id }, scopeFilter] },
    select: { id: true },
  });
  if (!visible) throw new Error("finding_not_found");

  await prisma.brainFinding.update({
    where: { id },
    data: {
      status: next.status,
      // Only written when the CALLER supplied it. Writing `?? null`
      // unconditionally wiped an existing reason whenever someone PATCHed
      // something else — reassigning a finding would silently delete the note
      // explaining it. The schema deliberately allows a reason to survive on a
      // non-dismissed row, so absence here means "unchanged", not "clear it".
      ...(next.dismissedReason !== undefined
        ? { dismissedReason: next.dismissedReason }
        : {}),
      ...(next.assigneeId !== undefined ? { assigneeId: next.assigneeId } : {}),
    },
  });
}
