/**
 * WARP-2117 — behaviour of the CRM service that a schema test cannot reach:
 * the money arithmetic, the stage-move contract, and the default-stage choice.
 *
 * Prisma is hand-stubbed in the style of `pm.service.counts.test.ts` — these
 * assertions are about this file's logic, not about Postgres. The constraints
 * (exactly-one subject, one default pipeline, amount↔currency) are tested
 * against real SQL in `crm-contacts.schema.test.ts` and enforced by the DB.
 */
import { describe, it, expect, vi } from "vitest";

import {
  CRM_ERRORS,
  createDeal,
  getPipelineSummary,
  listDeals,
  moveDealStage,
  normalizeDomain,
} from "./crm.service.js";

const stage = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "s-open",
  pipelineId: "p1",
  name: "Lead",
  kind: "OPEN" as const,
  sortOrder: 0,
  probability: null,
  ...over,
});

describe("normalizeDomain", () => {
  it("reduces a pasted URL to the dedupe key", () => {
    // A human pastes what is in their address bar. If `https://Example.com/pricing`
    // and `example.com` are two keys, the same customer arrives twice.
    expect(normalizeDomain("https://Example.com/pricing?utm=x")).toBe("example.com");
    expect(normalizeDomain("www.example.com")).toBe("example.com");
    expect(normalizeDomain("  EXAMPLE.com.  ")).toBe("example.com");
  });

  it("maps empty and absent to null rather than to an empty string", () => {
    // An empty-string domain would be a value that compares equal across every
    // company with no domain — a dedupe key that merges unrelated customers.
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });
});

describe("getPipelineSummary", () => {
  const pipelineWithStages = {
    id: "p1",
    name: "Sales",
    isDefault: true,
    sortOrder: 0,
    isArchived: false,
    stages: [
      stage({ id: "s1", name: "Lead", kind: "OPEN", sortOrder: 0 }),
      stage({ id: "s2", name: "Won", kind: "WON", sortOrder: 1 }),
    ],
  };

  it("sums minor units as BigInt, past the point a float would round", async () => {
    // 2^53 + 1 in minor units. Number() would return 9007199254740992 —
    // off by one, silently, in a currency figure.
    const deals = [
      { stageId: "s1", amountMinor: 9007199254740993n, currency: "USD" },
      { stageId: "s1", amountMinor: 7n, currency: "USD" },
    ];
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: { findMany: async () => deals },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages[0].amountMinor).toBe("9007199254741000");
    expect(summary.stages[0].currency).toBe("USD");
    expect(summary.stages[0].dealCount).toBe(2);
  });

  it("refuses to add across currencies and says so", async () => {
    // 500 EUR + 500 USD = 1000 of nothing. Reporting null is the honest answer;
    // reporting 1000 is a number a human would act on.
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: {
        findMany: async () => [
          { stageId: "s1", amountMinor: 50000n, currency: "USD" },
          { stageId: "s1", amountMinor: 50000n, currency: "EUR" },
        ],
      },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages[0].currency).toBeNull();
    expect(summary.stages[0].amountMinor).toBe("0");
    // The count is still true and still useful — only the total is withheld.
    expect(summary.stages[0].dealCount).toBe(2);
  });

  it("reports every stage, including the ones holding nothing", async () => {
    // A kanban with a missing column is a worse bug than an empty one.
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: { findMany: async () => [] },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages.map((s) => s.stageId)).toEqual(["s1", "s2"]);
    expect(summary.stages.every((s) => s.dealCount === 0)).toBe(true);
    expect(summary.stages[1].kind).toBe("WON");
  });
});

describe("moveDealStage", () => {
  it("refuses a stage from another pipeline with 422, not 404", async () => {
    // The id resolves — it is just wrong for this deal. Collapsing the two into
    // "not found" sends the caller looking for a typo that is not there.
    const prisma = {
      crmDeal: {
        findUnique: async () => ({
          id: "d1",
          pipelineId: "p1",
          stageId: "s1",
          closedAt: null,
          stage: stage({ id: "s1" }),
        }),
      },
      crmPipelineStage: { findUnique: async () => stage({ id: "sX", pipelineId: "OTHER" }) },
    } as never;

    await expect(moveDealStage(prisma, "d1", "sX", null)).rejects.toThrow(
      CRM_ERRORS.INVALID_STAGE,
    );
  });

  it("writes the STAGE_CHANGE in the same transaction as the move", async () => {
    // The board and the timeline must not be able to disagree. If the activity
    // write is a separate round trip, a crash between them leaves a deal that
    // moved with no record of who moved it.
    const dealUpdate = vi.fn().mockResolvedValue({});
    const activityCreate = vi.fn().mockResolvedValue({});
    const transaction = vi.fn().mockResolvedValue([{}, {}]);
    const prisma = {
      crmDeal: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: "d1",
            pipelineId: "p1",
            stageId: "s1",
            closedAt: null,
            stage: stage({ id: "s1", name: "Lead" }),
          })
          // The re-read at the end of moveDealStage (via getDeal).
          .mockResolvedValue({
            id: "d1",
            title: "T",
            companyId: null,
            company: null,
            pipelineId: "p1",
            stageId: "s2",
            stage: stage({ id: "s2", name: "Won", kind: "WON" }),
            amountMinor: null,
            currency: null,
            expectedCloseOn: null,
            closedAt: new Date("2026-08-29T00:00:00Z"),
            closeReason: null,
            ownerId: null,
            projectId: null,
            origin: "LOCAL",
            externalSystem: null,
            isArchived: false,
            contactLinks: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        update: dealUpdate,
      },
      crmPipelineStage: { findUnique: async () => stage({ id: "s2", name: "Won", kind: "WON" }) },
      crmActivity: { create: activityCreate },
      $transaction: transaction,
    } as never;

    await moveDealStage(prisma, "d1", "s2", "user-1");

    expect(transaction).toHaveBeenCalledTimes(1);
    // Both writes were handed to the SAME $transaction call, not issued loose.
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
    expect(dealUpdate).toHaveBeenCalledTimes(1);
    expect(activityCreate).toHaveBeenCalledTimes(1);

    const activityArgs = activityCreate.mock.calls[0][0].data;
    expect(activityArgs.kind).toBe("STAGE_CHANGE");
    expect(activityArgs.fromStageId).toBe("s1");
    expect(activityArgs.toStageId).toBe("s2");
    expect(activityArgs.summary).toBe("Lead → Won");
    expect(activityArgs.actorId).toBe("user-1");
  });

  it("stamps closedAt entering a WON stage and clears it going back to OPEN", async () => {
    // closedAt is an audit timestamp; the OUTCOME is always stage.kind. But a
    // reopened deal carrying a stale close date makes every "closed last month"
    // report wrong.
    async function move(fromKind: "OPEN" | "WON", toKind: "OPEN" | "WON", closedAt: Date | null) {
      const update = vi.fn().mockResolvedValue({});
      const prisma = {
        crmDeal: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce({
              id: "d1",
              pipelineId: "p1",
              stageId: "s1",
              closedAt,
              stage: stage({ id: "s1", kind: fromKind }),
            })
            .mockResolvedValue({
              id: "d1",
              title: "T",
              companyId: null,
              company: null,
              pipelineId: "p1",
              stageId: "s2",
              stage: stage({ id: "s2", kind: toKind }),
              amountMinor: null,
              currency: null,
              expectedCloseOn: null,
              closedAt: null,
              closeReason: null,
              ownerId: null,
              projectId: null,
              origin: "LOCAL",
              externalSystem: null,
              isArchived: false,
              contactLinks: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          update,
        },
        crmPipelineStage: { findUnique: async () => stage({ id: "s2", kind: toKind }) },
        crmActivity: { create: vi.fn().mockResolvedValue({}) },
        $transaction: vi.fn().mockResolvedValue([{}, {}]),
      } as never;
      await moveDealStage(prisma, "d1", "s2", null);
      return update.mock.calls[0][0].data;
    }

    expect((await move("OPEN", "WON", null)).closedAt).toBeInstanceOf(Date);
    expect((await move("WON", "OPEN", new Date("2026-01-01"))).closedAt).toBeNull();
    // Re-winning an already-won deal keeps the ORIGINAL close date rather than
    // silently re-dating the sale.
    const kept = await move("WON", "WON", new Date("2026-01-01"));
    expect(kept.closedAt).toEqual(new Date("2026-01-01"));
  });
});

describe("createDeal", () => {
  it("lands in the lowest-ordered OPEN stage, not simply the first stage", async () => {
    // A pipeline whose first column is a triage/lost bucket is legal, and a new
    // deal defaulting into it would be wrong on arrival.
    const create = vi.fn().mockResolvedValue({
      id: "d1",
      title: "T",
      companyId: null,
      company: null,
      pipelineId: "p1",
      stageId: "s2",
      stage: stage({ id: "s2", kind: "OPEN", sortOrder: 1 }),
      amountMinor: null,
      currency: null,
      expectedCloseOn: null,
      closedAt: null,
      closeReason: null,
      ownerId: null,
      projectId: null,
      origin: "LOCAL",
      externalSystem: null,
      isArchived: false,
      contactLinks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const prisma = {
      crmPipeline: {
        findUnique: async () => ({
          id: "p1",
          name: "Sales",
          isDefault: true,
          sortOrder: 0,
          isArchived: false,
          stages: [
            stage({ id: "s0", name: "Lost", kind: "LOST", sortOrder: 0 }),
            stage({ id: "s2", name: "Lead", kind: "OPEN", sortOrder: 1 }),
          ],
        }),
      },
      crmPipelineStage: { findUnique: async () => stage({ id: "s2", kind: "OPEN", sortOrder: 1 }) },
      crmDeal: { create },
    } as never;

    await createDeal(prisma, { title: "T", pipelineId: "p1" }, null);
    expect(create.mock.calls[0][0].data.stageId).toBe("s2");
  });

  it("rejects an amount with no currency before Postgres has to", async () => {
    // The CHECK constraint is the backstop. Failing here gives the caller a 422
    // naming the problem instead of a driver error naming a constraint.
    const prisma = {
      crmPipeline: {
        findUnique: async () => ({
          id: "p1",
          name: "Sales",
          isDefault: true,
          sortOrder: 0,
          isArchived: false,
          stages: [stage({ id: "s1" })],
        }),
      },
      crmPipelineStage: { findUnique: async () => stage({ id: "s1" }) },
      crmDeal: { create: vi.fn() },
    } as never;

    await expect(
      createDeal(prisma, { title: "T", pipelineId: "p1", amountMinor: "50000" }, null),
    ).rejects.toThrow(CRM_ERRORS.AMOUNT_NEEDS_CURRENCY);
  });

  it("marks a deal created straight into a WON stage as closed", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "d1",
      title: "T",
      companyId: null,
      company: null,
      pipelineId: "p1",
      stageId: "sw",
      stage: stage({ id: "sw", kind: "WON" }),
      amountMinor: null,
      currency: null,
      expectedCloseOn: null,
      closedAt: new Date(),
      closeReason: null,
      ownerId: null,
      projectId: null,
      origin: "LOCAL",
      externalSystem: null,
      isArchived: false,
      contactLinks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const prisma = {
      crmPipeline: {
        findUnique: async () => ({
          id: "p1",
          name: "Sales",
          isDefault: true,
          sortOrder: 0,
          isArchived: false,
          stages: [stage({ id: "sw", name: "Won", kind: "WON" })],
        }),
      },
      crmPipelineStage: { findUnique: async () => stage({ id: "sw", kind: "WON" }) },
      crmDeal: { create },
    } as never;

    await createDeal(prisma, { title: "T", pipelineId: "p1", stageId: "sw" }, null);
    expect(create.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
  });
});

describe("listDeals idleDays", () => {
  it("treats a deal with no activity at all as idle by its creation date", async () => {
    // The tempting filter — `activities: { every: { occurredAt: { lt } } }` —
    // matches a deal with ZERO activities vacuously, which would call a deal
    // created five minutes ago "idle for 14 days". Hence the explicit
    // no-activity arm keyed on createdAt.
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { crmDeal: { findMany, count: async () => 0 } } as never;

    await listDeals(prisma, { idleDays: 14 });
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0].activities).toEqual({ none: {} });
    expect(where.OR[0].createdAt.lt).toBeInstanceOf(Date);
    expect(where.OR[1].activities.every.occurredAt.lt).toBeInstanceOf(Date);
  });

  it("filters by outcome class rather than by stage name", async () => {
    // "Won" is a name an owner can rename to "Closed — signed". Anything that
    // matched on the string would stop working the day they did.
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { crmDeal: { findMany, count: async () => 0 } } as never;

    await listDeals(prisma, { kind: "WON" });
    expect(findMany.mock.calls[0][0].where.stage).toEqual({ kind: "WON" });
  });
});
