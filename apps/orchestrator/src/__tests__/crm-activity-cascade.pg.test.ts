/**
 * WARP-2554 — what happens to a HUMAN's timeline note when the record it hangs
 * off is deleted.
 *
 * The answer is "it goes too", for all three subject types, regardless of the
 * activity's own `origin`. That is correct and unavoidable: the
 * `CrmActivity_subject_exactly_one` CHECK forbids an orphan, so a subject
 * column cannot be SetNull and Cascade is the only coherent delete action.
 *
 * It is pinned here because it is **not discoverable from the code that will
 * rely on it**. A disconnect purge written as
 *
 *     prisma.crmActivity.deleteMany({ where: { origin: "EXTERNAL" } })
 *
 * reads as though it spares the owner's own notes. It does not — deleting the
 * synced parent has already taken them. The predicate offers protection it
 * cannot deliver, and the person writing WARP-2461's purge walker should meet
 * that as a failing assertion here rather than as missing data on a customer's
 * box.
 *
 * A mocked Prisma cannot prove a database cascade, so this suite is real-
 * Postgres and gated the same way the other `*.pg.test.ts` files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("CrmActivity cascades take LOCAL notes with the subject (WARP-2554)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Every fixture is namespaced `warp2554-` so cleanup and counts scope to
  // this suite: the pg-gated suites share one throwaway DB and run in
  // parallel, so an unscoped deleteMany() would eat another suite's rows.
  const OURS = { startsWith: "warp2554-" } as const;

  /**
   * WARP-2549 — a synced row now carries the CONNECTION it came from, and the
   * `*_provenance_complete` CHECK refuses one that does not. These fixtures
   * predate that column; they get a real connection rather than a relaxed
   * constraint, because the constraint is the point.
   */
  let connectionId: string;

  beforeEach(async () => {
    // FK-ordered, and scoped. Activities first so a failed run cannot leave a
    // row whose subject we are about to delete; the connection LAST, because
    // every landed row references it with RESTRICT.
    await prisma.crmActivity.deleteMany({ where: { summary: OURS } });
    await prisma.crmDeal.deleteMany({ where: { title: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.contact.deleteMany({ where: { displayName: OURS } });
    await prisma.crmPipeline.deleteMany({ where: { name: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });

    connectionId = (
      await prisma.integrationConnection.create({
        data: {
          provider: "warp2554-vendor",
          status: "CONNECTED",
          host: "warp2554-host",
          databaseName: "",
          secretRef: "warp2554-secret",
        },
        select: { id: true },
      })
    ).id;
  });

  async function pipelineWithStage(): Promise<{ pipelineId: string; stageId: string }> {
    const pipeline = await prisma.crmPipeline.create({
      data: {
        name: "warp2554-pipeline",
        // NOT the default: the partial unique index allows exactly one default
        // pipeline box-wide, and claiming it would collide with a real one.
        isDefault: false,
        stages: { create: { name: "warp2554-stage", kind: "OPEN", sortOrder: 0 } },
      },
      include: { stages: true },
    });
    return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  }

  it("deleting a synced DEAL destroys a locally-authored note on it", async () => {
    const { pipelineId, stageId } = await pipelineWithStage();
    const deal = await prisma.crmDeal.create({
      data: {
        title: "warp2554-deal",
        pipelineId,
        stageId,
        origin: "EXTERNAL",
        connectionId,
        externalSystem: "warp2554-vendor",
        externalId: "warp2554-deal-1",
      },
    });
    await prisma.crmActivity.create({
      data: {
        subjectType: "DEAL",
        dealId: deal.id,
        kind: "NOTE",
        summary: "warp2554-a-human-typed-this",
        // The whole point: this row is the OWNER's, not the vendor's.
        origin: "LOCAL",
      },
    });

    await prisma.crmDeal.delete({ where: { id: deal.id } });

    // Mutation: change the relation to anything but Cascade → the delete
    // throws an FK violation instead, and this expectation never runs.
    const survivors = await prisma.crmActivity.count({
      where: { summary: "warp2554-a-human-typed-this" },
    });
    expect(survivors).toBe(0);
  });

  it("deleting a synced COMPANY destroys a locally-authored note on it", async () => {
    const company = await prisma.crmCompany.create({
      data: {
        name: "warp2554-company",
        origin: "EXTERNAL",
        connectionId,
        externalSystem: "warp2554-vendor",
        externalId: "warp2554-co-1",
      },
    });
    await prisma.crmActivity.create({
      data: {
        subjectType: "COMPANY",
        companyId: company.id,
        kind: "CALL",
        summary: "warp2554-call-the-owner-logged",
        origin: "LOCAL",
      },
    });

    await prisma.crmCompany.delete({ where: { id: company.id } });

    expect(
      await prisma.crmActivity.count({ where: { summary: "warp2554-call-the-owner-logged" } }),
    ).toBe(0);
  });

  it("deleting a synced CONTACT destroys a locally-authored note on it", async () => {
    const contact = await prisma.contact.create({
      data: {
        userId: "warp2554-owner",
        displayName: "warp2554-person",
        origin: "EXTERNAL",
        connectionId,
        externalSystem: "warp2554-vendor",
        externalId: "warp2554-contact-1",
      },
    });
    await prisma.crmActivity.create({
      data: {
        subjectType: "CONTACT",
        contactId: contact.id,
        kind: "MEETING",
        summary: "warp2554-meeting-the-owner-logged",
        origin: "LOCAL",
      },
    });

    await prisma.contact.delete({ where: { id: contact.id } });

    expect(
      await prisma.crmActivity.count({ where: { summary: "warp2554-meeting-the-owner-logged" } }),
    ).toBe(0);
  });

  it("an origin-scoped purge therefore CANNOT protect local notes — proven, not asserted in prose", async () => {
    // This is the finding in executable form. Two deals, one synced and one
    // local, each carrying a LOCAL note. A purge that deletes only EXTERNAL
    // *activities* leaves both notes; a purge that deletes the EXTERNAL
    // *deal* — which is what a real disconnect purge does — takes one of them
    // regardless of the `origin: "EXTERNAL"` predicate on the activity table.
    const { pipelineId, stageId } = await pipelineWithStage();
    const synced = await prisma.crmDeal.create({
      data: {
        title: "warp2554-synced-deal",
        pipelineId,
        stageId,
        origin: "EXTERNAL",
        connectionId,
        externalSystem: "warp2554-vendor",
        externalId: "warp2554-deal-2",
      },
    });
    const local = await prisma.crmDeal.create({
      data: { title: "warp2554-local-deal", pipelineId, stageId, origin: "LOCAL" },
    });
    await prisma.crmActivity.createMany({
      data: [
        { subjectType: "DEAL", dealId: synced.id, kind: "NOTE", summary: "warp2554-note-on-synced", origin: "LOCAL" },
        { subjectType: "DEAL", dealId: local.id, kind: "NOTE", summary: "warp2554-note-on-local", origin: "LOCAL" },
      ],
    });

    // Step 1 — the predicate a purge author would reach for. It removes
    // nothing, because BOTH notes are LOCAL.
    const byPredicate = await prisma.crmActivity.deleteMany({
      where: { origin: "EXTERNAL", summary: OURS },
    });
    expect(byPredicate.count).toBe(0);

    // Step 2 — the delete that actually happens on disconnect.
    await prisma.crmDeal.delete({ where: { id: synced.id } });

    // The note on the synced deal is gone despite step 1 sparing it, and the
    // note on the local deal is untouched. That asymmetry is the whole point.
    expect(await prisma.crmActivity.count({ where: { summary: "warp2554-note-on-synced" } })).toBe(0);
    expect(await prisma.crmActivity.count({ where: { summary: "warp2554-note-on-local" } })).toBe(1);
  });
});
