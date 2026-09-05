/**
 * WARP-2730 (ADR-048) — the loop, against a real Postgres.
 *
 * Four things live here because nothing else can hold them:
 *
 *   1. THE CLAIM RACE. `FOR UPDATE SKIP LOCKED` + a guarded `updateMany` is the
 *      only exclusion this worker has — the tick carries no `lockKey`, on
 *      purpose (a 60 s transaction cannot wrap a CPU-inference call). If the
 *      claim is not atomic, two ticks extract the same file, spend two model
 *      runs on it, and race to write the same terminal row. A mocked test
 *      cannot see this: the guard "fires" correctly in both callers.
 *
 *   2. THE RE-ARM WATERMARK. `set_index_status` bumps `updatedAt` on every
 *      upsert, including a metadata-only touch, and a file modified WHILE the
 *      worker holds the claim must still come back. Writing `now()` as the
 *      watermark would overtake that bump and the file could never be read
 *      again — a failure indistinguishable from "the model found nothing".
 *
 *   3. APPLY, TWICE. Two tabs, one customer. The loser must get a refusal, not
 *      a second company.
 *
 *   4. THE DEFINITION OF DONE, end to end: a proposal applied through the real
 *      service produces a `CrmCompany` with `origin: EXTRACTED` and an
 *      `EntityLink` with `linkedBy: EXTRACTED`, and the company is VISIBLE
 *      over the real HTTP surface — `GET /api/crm/companies/:id` through a
 *      loopback `serve(createApp(prisma))`, not a service call dressed up as
 *      one.
 *
 * Real-Postgres and gated exactly like the sibling `*.pg.test.ts` suites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("the filing loop against a real database (WARP-2730)", () => {
  let prisma: PrismaClient;
  let applyProposal: typeof import("../services/filing/apply.service.js").applyProposal;
  let FILING_ERRORS: typeof import("../services/filing/apply.service.js").FILING_ERRORS;
  let runFilingReconcile: typeof import("../services/filing/reconcile.js").runFilingReconcile;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    ({ applyProposal, FILING_ERRORS } = await import("../services/filing/apply.service.js"));
    ({ runFilingReconcile } = await import("../services/filing/reconcile.js"));
    const existing = await prisma.moduleSetting.findUnique({ where: { moduleId: "crm" } });
    crmModuleWasEnabled = existing?.enabled ?? null;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Namespaced. The pg-gated files share one throwaway DB; an unscoped
  // deleteMany() here would eat another suite's rows.
  const P = "warp2730-";

  /** The module state this suite flips. Restored in `afterAll` rather than
   *  left on: the pg files share one throwaway database, and leaving a module
   *  enabled would silently change what a sibling suite's gate does. */
  let crmModuleWasEnabled: boolean | null = null;

  async function cleanup() {
    await prisma.entityLink.deleteMany({ where: { filePath: { startsWith: `/${P}` } } });
    await prisma.ingestProposal.deleteMany({ where: { sourceRef: { startsWith: P } } });
    await prisma.crmCompany.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.fileIndexStatus.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.filingDecision.deleteMany({ where: { keyValue: { startsWith: P } } });
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    if (crmModuleWasEnabled === null) {
      await prisma.moduleSetting.deleteMany({ where: { moduleId: "crm" } });
    } else {
      await prisma.moduleSetting.update({
        where: { moduleId: "crm" },
        data: { enabled: crmModuleWasEnabled },
      });
    }
  });

  // ── 1 + 2: the claim ─────────────────────────────────────────────────────

  /**
   * The claim, lifted verbatim from `worker.ts`.
   *
   * Duplicated rather than imported because `claimOne` is deliberately not
   * exported — the worker's public surface is one tick — and because what is
   * under test is the SQL SHAPE, which a re-export would let drift. The
   * duplication is load-bearing: if `worker.ts`'s predicate changes and this
   * one does not, the test still proves the shape it names, and the worker's
   * own behaviour is covered by the unit suite.
   */
  async function claimOne(owners: string[]): Promise<{ path: string; updatedAt: Date } | null> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ userId: string; path: string; updatedAt: Date }[]>`
        SELECT "userId", "path", "updatedAt"
        FROM "FileIndexStatus"
        WHERE "status" = 'ready'
          AND "ncFileId" IS NOT NULL
          AND "userId" = ANY(${owners})
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
        where: { userId: row.userId, path: row.path, extractStatus: { in: ["pending", "done"] } },
        data: {
          extractStatus: "running",
          extractClaimedAt: new Date(),
          extractAttempts: { increment: 1 },
          extractedAt: null,
          extractReason: null,
        },
      });
      return claimed.count === 1 ? { path: row.path, updatedAt: row.updatedAt } : null;
    });
  }

  const OWNER_NC = `${P}owner`;

  async function seedIndexedFile(path: string, ncFileId: number) {
    await prisma.fileIndexStatus.create({
      data: {
        userId: OWNER_NC,
        path,
        ncFileId,
        status: "ready",
        extractStatus: "pending",
      },
    });
  }

  it("🔴 two concurrent claims produce exactly one winner", async () => {
    await seedIndexedFile(`/${P}Customers/acme.pdf`, 990001);

    // Fired together, not awaited in sequence: sequencing them would prove
    // nothing about SKIP LOCKED.
    const [a, b] = await Promise.all([claimOne([OWNER_NC]), claimOne([OWNER_NC])]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);

    const row = await prisma.fileIndexStatus.findUniqueOrThrow({
      where: { userId_path: { userId: OWNER_NC, path: `/${P}Customers/acme.pdf` } },
    });
    expect(row.extractStatus).toBe("running");
    // ONE attempt, not two. A second increment would mean both claimants
    // touched the row and the budget would burn twice as fast.
    expect(row.extractAttempts).toBe(1);
  });

  it("🔴 a file touched mid-claim re-arms; one touched before does not", async () => {
    const path = `/${P}Customers/moving.pdf`;
    await seedIndexedFile(path, 990002);

    const claim = await claimOne([OWNER_NC]);
    expect(claim).not.toBeNull();

    // The touch: `set_index_status` bumps `updatedAt` on every upsert.
    await prisma.$executeRaw`
      UPDATE "FileIndexStatus" SET "updatedAt" = NOW() + interval '1 second'
      WHERE "userId" = ${OWNER_NC} AND "path" = ${path}
    `;

    // The terminal write uses the watermark SNAPSHOTTED AT CLAIM TIME.
    await prisma.fileIndexStatus.updateMany({
      where: { userId: OWNER_NC, path, extractStatus: "running" },
      data: {
        extractStatus: "done",
        extractedAt: new Date(),
        extractedFromUpdatedAt: claim!.updatedAt,
        extractClaimedAt: null,
        extractFingerprint: "c1:abc",
      },
    });

    // MUTATION: write `new Date()` as the watermark instead — this goes red,
    // and the file is never read again.
    expect(await claimOne([OWNER_NC])).not.toBeNull();
  });

  it("a done row whose watermark is current is NOT re-claimed", async () => {
    const path = `/${P}Customers/settled.pdf`;
    await seedIndexedFile(path, 990003);
    const row = await prisma.fileIndexStatus.findUniqueOrThrow({
      where: { userId_path: { userId: OWNER_NC, path } },
    });
    await prisma.fileIndexStatus.update({
      where: { userId_path: { userId: OWNER_NC, path } },
      data: {
        extractStatus: "done",
        extractedAt: new Date(),
        extractedFromUpdatedAt: row.updatedAt,
      },
    });
    expect(await claimOne([OWNER_NC])).toBeNull();
  });

  it("a skipped row does not re-arm on a touch — a PHI skip is sticky", async () => {
    const path = `/${P}Patients/chart.pdf`;
    await seedIndexedFile(path, 990004);
    await prisma.fileIndexStatus.update({
      where: { userId_path: { userId: OWNER_NC, path } },
      data: {
        extractStatus: "skipped",
        extractReason: "phi_path",
        extractedAt: new Date(),
      },
    });
    await prisma.$executeRaw`
      UPDATE "FileIndexStatus" SET "updatedAt" = NOW() + interval '1 hour'
      WHERE "userId" = ${OWNER_NC} AND "path" = ${path}
    `;
    expect(await claimOne([OWNER_NC])).toBeNull();
  });

  it("another owner's file is never claimed", async () => {
    await prisma.fileIndexStatus.create({
      data: {
        userId: `${P}someone-else`,
        path: `/${P}Customers/theirs.pdf`,
        ncFileId: 990005,
        status: "ready",
        extractStatus: "pending",
      },
    });
    expect(await claimOne([OWNER_NC])).toBeNull();
  });

  it("the reconcile re-arms a dead claim and gives up on an exhausted one", async () => {
    const alive = `/${P}Customers/stalled.pdf`;
    const spent = `/${P}Customers/exhausted.pdf`;
    await seedIndexedFile(alive, 990006);
    await seedIndexedFile(spent, 990007);
    const stale = new Date(Date.now() - 60 * 60_000);
    for (const [path, attempts] of [
      [alive, 1],
      [spent, 3],
    ] as const) {
      await prisma.fileIndexStatus.update({
        where: { userId_path: { userId: OWNER_NC, path } },
        data: { extractStatus: "running", extractClaimedAt: stale, extractAttempts: attempts },
      });
    }

    const result = await runFilingReconcile(prisma);
    expect(result.reArmed).toBeGreaterThanOrEqual(1);
    expect(result.givenUp).toBeGreaterThanOrEqual(1);

    const a = await prisma.fileIndexStatus.findUniqueOrThrow({
      where: { userId_path: { userId: OWNER_NC, path: alive } },
    });
    const b = await prisma.fileIndexStatus.findUniqueOrThrow({
      where: { userId_path: { userId: OWNER_NC, path: spent } },
    });
    expect(a.extractStatus).toBe("pending");
    expect(b.extractStatus).toBe("failed");
    expect(b.extractReason).toBe("stale_claim");
  });

  // ── 3 + 4: apply ─────────────────────────────────────────────────────────

  const FILE = {
    ncFileId: 990100,
    filePath: `/${P}Customers/acme-invoice.pdf`,
    fileSpace: "files",
  };

  async function seedProposal(): Promise<string> {
    const row = await prisma.ingestProposal.create({
      data: {
        sourceKind: "FILE",
        sourceRef: `${P}file:${FILE.ncFileId}`,
        ncFileId: FILE.ncFileId,
        kind: "CREATE_CUSTOMER",
        policyClass: "REVIEW",
        policyReason: "Droplet is set to ask you first.",
        confidence: 93,
        phiVerdict: "CLEAN",
        matchKind: "NONE",
        payload: { name: `${P}ACME Dental Supply Ltd`, domain: "acme-dental.example", file: FILE },
        evidence: [{ quote: "ACME Dental Supply Ltd" }],
        extractorVersion: "filing-1",
        dedupeKey: `${P}acme dental supply`,
        requestedById: "u-owner",
      },
      select: { id: true },
    });
    return row.id;
  }

  const ctx = {
    actorId: "u-owner",
    resolveFileId: async () => FILE.ncFileId,
  };

  it("🔴 applying twice yields one customer and one refusal", async () => {
    const id = await seedProposal();

    const results = await Promise.allSettled([
      applyProposal(prisma, id, ctx),
      applyProposal(prisma, id, ctx),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      message: FILING_ERRORS.NOT_PENDING,
    });

    const companies = await prisma.crmCompany.findMany({
      where: { name: { startsWith: P } },
    });
    expect(companies).toHaveLength(1);
  });

  it("🔴 the applied customer carries EXTRACTED provenance and the document", async () => {
    const id = await seedProposal();
    const result = await applyProposal(prisma, id, ctx);

    const company = await prisma.crmCompany.findUniqueOrThrow({
      where: { id: result.createdCompanyId! },
    });
    // The "Created by Droplet" chip reads THIS, never `createdById IS NULL`.
    expect(company.origin).toBe("EXTRACTED");
    expect(company.proposalId).toBe(id);
    // A real User.id, never null: "who is accountable for this row" must have
    // an answer even when nobody typed it.
    expect(company.createdById).toBe("u-owner");

    const link = await prisma.entityLink.findUniqueOrThrow({
      where: { id: result.createdEntityLinkId! },
    });
    expect(link.linkedBy).toBe("EXTRACTED");
    expect(link.companyId).toBe(company.id);
    expect(link.confidence).toBe(93);

    // 🔴 NO FILENAME in the timeline row. Filenames are PHI (WARP-1983) and a
    // CrmActivity summary is rendered for every reader of the CRM; the
    // document's identity lives on the access-checked EntityLink.
    const activities = await prisma.crmActivity.findMany({
      where: { companyId: company.id },
    });
    expect(activities.length).toBeGreaterThanOrEqual(1);
    for (const a of activities) {
      expect(a.summary).not.toContain("acme-invoice.pdf");
      expect(a.summary).not.toContain(".pdf");
    }
  });

  it("🔴 a file that moved since Droplet read it is refused, and nothing is written", async () => {
    const id = await seedProposal();
    await expect(
      // The path now resolves to a DIFFERENT fileid — deleted and re-uploaded,
      // which is exactly the case the stored (ncFileId, path) pair cannot see.
      applyProposal(prisma, id, { actorId: "u-owner", resolveFileId: async () => 777777 }),
    ).rejects.toThrow(FILING_ERRORS.SOURCE_CHANGED);

    expect(await prisma.crmCompany.count({ where: { name: { startsWith: P } } })).toBe(0);
    const after = await prisma.ingestProposal.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("PENDING");
  });

  it("a deleted file is refused the same way", async () => {
    const id = await seedProposal();
    await expect(
      applyProposal(prisma, id, { actorId: "u-owner", resolveFileId: async () => null }),
    ).rejects.toThrow(FILING_ERRORS.SOURCE_CHANGED);
  });

  it("🔴 a NEVER-class proposal is refused even for a human who clicks", async () => {
    const row = await prisma.ingestProposal.create({
      data: {
        sourceKind: "FILE",
        sourceRef: `${P}file:990200`,
        ncFileId: 990200,
        kind: "CREATE_MONEY_DOC",
        policyClass: "NEVER",
        policyReason: "Droplet does not file these into your books yet.",
        confidence: 90,
        phiVerdict: "CLEAN",
        matchKind: "NONE",
        payload: { kind: "INVOICE", currency: "USD", total: "4250.00", direction: "PAYABLE" },
        extractorVersion: "filing-1",
        dedupeKey: `${P}INVOICE::USD:4250.00`,
        requestedById: "u-owner",
      },
      select: { id: true },
    });
    await expect(applyProposal(prisma, row.id, ctx)).rejects.toThrow(
      FILING_ERRORS.NEVER_APPLIABLE,
    );
  });

  it("🔴 the applied customer is VISIBLE over the real HTTP surface", async () => {
    // The definition of done's last clause. Everything above proves rows
    // exist; this proves a person can see them — a real listening socket, the
    // real Express app, the real CRM route. A service call asserting its own
    // return value would prove none of that, and "the row is there but the
    // page is empty" is a shape this box has shipped before
    // (`GET /api/files` answering 200 [] on an outage).
    const id = await seedProposal();
    const result = await applyProposal(prisma, id, ctx);

    // 🔴 The `crm` module is `defaultEnabled: false` in the registry, and
    // `mountModuleGates` 404s a route whose module is off. That 404 is the gate
    // working — and it is exactly why this test is worth having: everything
    // above proves rows exist, and a row nobody can reach is not a feature.
    // Enable the module the way the box does, through its own table.
    await prisma.moduleSetting.upsert({
      where: { moduleId: "crm" },
      create: { moduleId: "crm", enabled: true, setBy: "warp2730-pg" },
      update: { enabled: true },
    });

    const { createApp } = await import("../app.js");
    const app = createApp(prisma) as unknown as {
      listen: (port: number, host: string, cb: () => void) => {
        address: () => { port: number };
        close: (cb: () => void) => void;
        once: (e: string, f: (err: unknown) => void) => void;
      };
    };
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/api/crm/companies/${result.createdCompanyId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; name: string; origin: string };
      expect(body.id).toBe(result.createdCompanyId);
      expect(body.name).toBe(`${P}ACME Dental Supply Ltd`);
      expect(body.origin).toBe("EXTRACTED");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("rejecting forgets the quotes in the same statement", async () => {
    const id = await seedProposal();
    const { rejectProposal } = await import("../services/filing/apply.service.js");
    await rejectProposal(prisma, id, "u-owner");
    const after = await prisma.ingestProposal.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("REJECTED");
    // The owner has just said this filing was wrong. Keeping the quotes would
    // be keeping a copy of a document nobody agreed to keep.
    expect(after.evidence).toBeNull();
    expect(after.decidedById).toBe("u-owner");
  });
});
