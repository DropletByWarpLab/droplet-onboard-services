/**
 * WARP-2748 (ADR-051) — the brain invariants only a REAL Postgres can prove.
 *
 * WHY THESE CASES RUN HERE, and not in the DB-less lane:
 *
 *   provenance   — `BrainDigest_sources_not_empty` / `BrainFinding_evidence_not_empty`
 *                  are raw migration SQL. Prisma's schema language cannot say
 *                  "this JSON column is a non-empty array", so a mocked client
 *                  happily "writes" a row with `sources: []`. Only Postgres
 *                  refuses — and the refusal is the whole reason to trust a
 *                  digest: a row nobody can trace to a source is a
 *                  hallucination with a row id.
 *   idempotency  — and this is the case worth reading. The obvious design is
 *                  `@@unique([kind, subjectType, subjectId, detectorKey])`.
 *                  That index would reject NOTHING: `subjectType`/`subjectId`
 *                  are NULL on every theme-shaped row, NULL never equals NULL,
 *                  so no two rows collide and P2002 never fires. `EntityLink`
 *                  hit exactly this and paid for it with five PARTIAL unique
 *                  indexes that `prisma.upsert` cannot address. The shipped
 *                  design is one NOT NULL derived `dedupeKey`. The test below
 *                  fails if anyone "simplifies" it back.
 *   scope shape  — `*_department_scope_needs_id`. A department-scoped row with
 *                  no department is unenforceable: the reader check is "is
 *                  this person a member of THAT groupfolder" and there is
 *                  nothing to ask about.
 *   cascade      — deleting a Department takes its brain rows. Forced, not
 *                  chosen: `departmentId` is an ACCESS-CONTROL key, and an
 *                  access key that dangles is a leak.
 *   ranges       — confidence 0-100, impact-needs-currency, dismissal-needs-reason.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites and the lane runs
 * --no-file-parallelism. Every row is namespaced `warp2748-` and every cleanup
 * is scoped to that prefix. Never an unscoped deleteMany, never a TRUNCATE
 * (the access-role.pg.test.ts rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { upsertDigest, upsertFinding } from "../services/brain/brain-digest.service";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const P = "warp2748-";
const SOURCES = [{ sourceKind: "file", sourceId: `${P}file-1`, quote: "net 30 from delivery" }];

describe.skipIf(!RUN)("Brain digest/finding — real Postgres (WARP-2748)", () => {
  let prisma: PrismaClient;
  let deptId: string;
  let ownerId: string;

  beforeAll(async () => {
    // `setup.ts` mocks `@prisma/client` GLOBALLY for the DB-less lane, so a
    // plain `new PrismaClient()` here returns the mock — an object with no
    // model delegates, whose first use fails as
    // "Cannot read properties of undefined (reading 'deleteMany')" rather than
    // as anything resembling a database problem. Every `*.pg.test.ts` must
    // reach past the mock; this is the `entity-link.pg.test.ts` pattern.
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.brainFinding.deleteMany({ where: { detectorKey: { startsWith: P } } });
    await prisma.brainDigest.deleteMany({ where: { detectorKey: { startsWith: P } } });
    await prisma.department.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brainFinding.deleteMany({ where: { detectorKey: { startsWith: P } } });
    await prisma.brainDigest.deleteMany({ where: { detectorKey: { startsWith: P } } });
    await prisma.department.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
    const user = await prisma.user.create({
      data: {
        username: `${P}owner`,
        displayName: `${P}owner`,
        role: "owner",
      },
      select: { id: true },
    });
    ownerId = user.id;

    const dept = await prisma.department.create({
      // `slug` and `createdBy` are required; `state: active` is what
      // `readableDepartmentIdsFor` filters on for the owner/admin see-all arm.
      data: {
        name: `${P}ops`,
        slug: `${P}ops`,
        state: "active",
        createdBy: `${P}seed`,
      },
      select: { id: true },
    });
    deptId = dept.id;
  });

  // ── provenance ───────────────────────────────────────────────────────────

  it("REFUSES a digest with an empty sources array", async () => {
    // Bypasses the service's own validation on purpose: this asserts the
    // DATABASE refuses, so a future caller that skips the service still cannot
    // write an untraceable row.
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: [],
          ownerId,
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:-`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_sources_not_empty/);
  });

  it("REFUSES a digest whose sources is an object, not an array", async () => {
    // '{}'::jsonb is valid JSON and would pass a naive length check.
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: { sourceKind: "file" },
          ownerId,
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:-2`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_sources_not_empty/);
  });

  it("REFUSES a finding whose evidence carries no sources", async () => {
    await expect(
      prisma.brainFinding.create({
        data: {
          kind: "loss",
          title: "t",
          rationale: "r",
          evidence: { digestIds: ["x"], sources: [] },
          ownerId,
          detectorKey: `${P}f`,
          dedupeKey: `${P}f:loss:-:-`,
        },
      }),
    ).rejects.toThrow(/BrainFinding_evidence_not_empty/);
  });

  it("ACCEPTS a digest with one real source", async () => {
    const { id } = await upsertDigest(prisma, {
      kind: "obligation",
      title: "Acme is net 30",
      body: "The 2026 MSA sets payment terms at net 30 from delivery.",
      sources: SOURCES,
      ownerId,
      detectorKey: `${P}obligations`,
    });
    expect(id).toBeTruthy();
  });

  // ── idempotency ──────────────────────────────────────────────────────────

  it("upserting the same digest twice leaves ONE row and advances lastConfirmedAt", async () => {
    // The contract the whole nightly design rests on. If this ever creates two
    // rows, the loop accumulates near-duplicates and the operator mutes it.
    const input = {
      kind: "entity" as const,
      title: "Acme Ltd is a customer",
      body: "Seen across three contracts and an invoice.",
      subjectType: "COMPANY" as const,
      subjectId: `${P}co-1`,
      sources: SOURCES,
      ownerId,
      detectorKey: `${P}entities`,
    };

    const first = await upsertDigest(prisma, input);
    expect(first.created).toBe(true);
    const afterFirst = await prisma.brainDigest.findUnique({ where: { id: first.id } });

    const second = await upsertDigest(prisma, input);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await prisma.brainDigest.findMany({
      where: { detectorKey: `${P}entities` },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastConfirmedAt.getTime()).toBeGreaterThanOrEqual(
      afterFirst!.lastConfirmedAt.getTime(),
    );
    // firstSeenAt is the accumulation record and must NOT move.
    expect(rows[0]!.firstSeenAt.getTime()).toBe(afterFirst!.firstSeenAt.getTime());
  });

  it("two theme-shaped digests with NULL subjects still collide when the detector+kind match", async () => {
    // THE case a compound unique over nullable columns would miss entirely.
    const base = {
      kind: "theme" as const,
      title: "Cash collection is slipping",
      body: "Three customers moved past 60 days this quarter.",
      sources: SOURCES,
      ownerId,
      detectorKey: `${P}themes`,
    };
    await upsertDigest(prisma, base);
    await upsertDigest(prisma, { ...base, title: "Cash collection is slipping further" });

    const rows = await prisma.brainDigest.findMany({ where: { detectorKey: `${P}themes` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Cash collection is slipping further");
  });

  it("a dismissed finding is NOT resurrected by a later pass that still sees the condition", async () => {
    const input = {
      kind: "loss" as const,
      title: "Invoice 41 is 90 days overdue",
      rationale: "Balance unchanged since June.",
      evidence: { sources: SOURCES },
      ownerId,
      detectorKey: `${P}ageing`,
      subjectKey: `${P}inv-41`,
    };
    const { id } = await upsertFinding(prisma, input);
    await prisma.brainFinding.update({
      where: { id },
      data: { status: "dismissed", dismissedReason: "customer on an agreed plan" },
    });

    const again = await upsertFinding(prisma, input);
    expect(again.id).toBe(id);

    const row = await prisma.brainFinding.findUnique({ where: { id } });
    expect(row!.status).toBe("dismissed");
    expect(row!.dismissedReason).toBe("customer on an agreed plan");
  });

  // ── scope shape and cascade ──────────────────────────────────────────────

  it("REFUSES a department-scoped row with no departmentId", async () => {
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: SOURCES,
          scope: "department",
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:dept-missing`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_department_scope_needs_id/);
  });

  it("REFUSES a company-scoped row that carries a departmentId", async () => {
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: SOURCES,
          scope: "company",
          departmentId: deptId,
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:dept-stray`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_department_scope_needs_id/);
  });

  it("deleting a Department CASCADES its brain rows — an access key must never dangle", async () => {
    await upsertDigest(prisma, {
      kind: "theme",
      title: "Ops throughput",
      body: "b",
      sources: SOURCES,
      scope: "department",
      departmentId: deptId,
      detectorKey: `${P}dept`,
    });
    expect(await prisma.brainDigest.count({ where: { detectorKey: `${P}dept` } })).toBe(1);

    await prisma.department.delete({ where: { id: deptId } });
    expect(await prisma.brainDigest.count({ where: { detectorKey: `${P}dept` } })).toBe(0);
  });

  // ── ranges ───────────────────────────────────────────────────────────────

  it("REFUSES a personal-scope row with no owner — the leak this closes", async () => {
    // Without this CHECK, `personal` was a label nothing enforced: neither
    // table had an owner column, so every reader saw every other reader's
    // rows through the brain block on /llm/chat.
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: SOURCES,
          scope: "personal",
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:noowner`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_personal_scope_needs_owner/);
  });

  it("REFUSES a company-scope row that carries an owner", async () => {
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: SOURCES,
          scope: "company",
          ownerId,
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:strayowner`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_personal_scope_needs_owner/);
  });

  it("deleting the owner CASCADES their personal rows", async () => {
    await upsertDigest(prisma, {
      kind: "theme",
      title: "Mine",
      body: "b",
      sources: SOURCES,
      ownerId,
      detectorKey: `${P}owned`,
    });
    expect(await prisma.brainDigest.count({ where: { detectorKey: `${P}owned` } })).toBe(1);
    await prisma.user.delete({ where: { id: ownerId } });
    expect(await prisma.brainDigest.count({ where: { detectorKey: `${P}owned` } })).toBe(0);
  });

  it("REFUSES a confidence above 100", async () => {
    await expect(
      prisma.brainDigest.create({
        data: {
          kind: "theme",
          title: "t",
          body: "b",
          sources: SOURCES,
          confidence: 3000,
          ownerId,
          detectorKey: `${P}d`,
          dedupeKey: `${P}d:theme:-:conf`,
        },
      }),
    ).rejects.toThrow(/BrainDigest_confidence_range/);
  });

  it("REFUSES an impact with no currency", async () => {
    await expect(
      prisma.brainFinding.create({
        data: {
          kind: "loss",
          title: "t",
          rationale: "r",
          evidence: { sources: SOURCES },
          impactMinor: 4000n,
          ownerId,
          detectorKey: `${P}f`,
          dedupeKey: `${P}f:loss:-:cur`,
        },
      }),
    ).rejects.toThrow(/BrainFinding_impact_needs_currency/);
  });

  it("REFUSES a dismissal with no reason", async () => {
    const { id } = await upsertFinding(prisma, {
      kind: "loss",
      title: "t",
      rationale: "r",
      evidence: { sources: SOURCES },
      ownerId,
      detectorKey: `${P}dismiss`,
    });
    await expect(
      prisma.brainFinding.update({ where: { id }, data: { status: "dismissed" } }),
    ).rejects.toThrow(/BrainFinding_dismissed_needs_reason/);
  });
});
