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
  deleteCompany,
  deleteDeal,
  getPipelineSummary,
  listDeals,
  moveDealStage,
  normalizeDomain,
  updateDeal,
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
    expect(summary.stages[0].valuation).toBe("mixed_currencies");
    expect(summary.stages[0].currency).toBeNull();
    expect(summary.stages[0].amountMinor).toBe("0");
    // The count is still true and still useful — only the total is withheld.
    expect(summary.stages[0].dealCount).toBe(2);
  });

  it("distinguishes 'nothing priced yet' from 'mixed currencies' (WARP-2556)", async () => {
    // THE regression. These two states used to be byte-identical on the wire —
    // both `{ amountMinor: "0", currency: null }` — so `crm_pipeline_summary`,
    // which branched on `currency === null`, told the model "mixed currencies"
    // for a stage where nobody had entered an amount at all. That is most
    // early-pipeline stages on most boxes.
    //
    // Mutation: collapse `valuation` back to `mixed ? null : (…?? null)` → the
    // two expectations below become identical and this goes red.
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: {
        findMany: async () => [
          // Three real deals nobody has put a number on. Not an empty stage.
          { stageId: "s1", amountMinor: null, currency: null },
          { stageId: "s1", amountMinor: null, currency: null },
          { stageId: "s1", amountMinor: null, currency: null },
        ],
      },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages[0].valuation).toBe("unpriced");
    expect(summary.stages[0].dealCount).toBe(3);
    // Still null/"0" on the wire — but now SAYING which of the two it is.
    expect(summary.stages[0].currency).toBeNull();
    expect(summary.stages[0].amountMinor).toBe("0");
  });

  it("reports a single-currency stage as priced, with the real total", async () => {
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: {
        findMany: async () => [
          { stageId: "s1", amountMinor: 50000n, currency: "USD" },
          // An unpriced deal alongside priced ones does NOT make the stage
          // unpriced — it contributes nothing to the total and nothing to the
          // currency set. Mutation: count deals instead of currencies → red.
          { stageId: "s1", amountMinor: null, currency: null },
        ],
      },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages[0].valuation).toBe("priced");
    expect(summary.stages[0].currency).toBe("USD");
    expect(summary.stages[0].amountMinor).toBe("50000");
    expect(summary.stages[0].dealCount).toBe(2);
  });

  it("never counts money it cannot denominate (empty-string currency)", async () => {
    // The two bucket conditions used to disagree on the empty string: the
    // currency guard (`if (deal.currency)`) skipped it, the amount guard
    // (`!== null`) did not. So this row put 50000 into `total` while leaving
    // `currencies` empty — the stage classified as `unpriced`, and `unpriced`
    // reports `amountMinor: "0"`, throwing the total away and telling the
    // model "no amounts entered yet" about a stage holding money.
    //
    // Postgres `CHECK`s only null-PAIRING, not non-emptiness, so this row is
    // reachable from an import or a migration without touching the Zod schema
    // that would reject it.
    //
    // Mutation: split the pairing back into two independent `if`s → `total`
    // takes the 50000 the currency set never accounts for, and the invariant
    // asserted here breaks.
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: {
        findMany: async () => [
          { stageId: "s1", amountMinor: 50000n, currency: "" },
          { stageId: "s1", amountMinor: 25000n, currency: "   " },
        ],
      },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    // Both deals are still REAL and still counted — only their unusable
    // amounts are withheld.
    expect(summary.stages[0].dealCount).toBe(2);
    expect(summary.stages[0].valuation).toBe("unpriced");
    expect(summary.stages[0].currency).toBeNull();
    // "0" because nothing here is denominated — never because a real total
    // was accumulated and then discarded.
    expect(summary.stages[0].amountMinor).toBe("0");
  });

  it("a padded currency still prices the stage, normalised", async () => {
    // The other side of the trim: `" USD "` is a usable currency, not an
    // unpriced deal, and it must not split `USD` into two currency values and
    // read as `mixed_currencies`.
    const prisma = {
      crmPipeline: { findUnique: async () => pipelineWithStages },
      crmDeal: {
        findMany: async () => [
          { stageId: "s1", amountMinor: 50000n, currency: "USD" },
          { stageId: "s1", amountMinor: 25000n, currency: " USD " },
        ],
      },
    } as never;

    const summary = await getPipelineSummary(prisma, "p1");
    expect(summary.stages[0].valuation).toBe("priced");
    expect(summary.stages[0].currency).toBe("USD");
    expect(summary.stages[0].amountMinor).toBe("75000");
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
    // An empty stage is `unpriced`, not `mixed_currencies` (WARP-2556).
    expect(summary.stages.every((s) => s.valuation === "unpriced")).toBe(true);
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
    // Interactive form: the move is now a callback so `updateDeal` can commit
    // it together with the rest of a PATCH. The stub runs the callback against
    // a tx client, which is what proves both writes went through the SAME one
    // rather than being issued loose on `prisma`.
    const txClient = { crmDeal: { update: dealUpdate }, crmActivity: { create: activityCreate } };
    const transaction = vi.fn(async (fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient));
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
    // Both writes went through the SAME $transaction call, not issued loose:
    // the mocks live only on the tx client the callback was handed.
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
        // The move writes through the transaction client, so the stub has to
        // run the callback for `update` to see anything.
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ crmDeal: { update }, crmActivity: { create: vi.fn().mockResolvedValue({}) } }),
        ),
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

describe("updateDeal", () => {
  /** A deal row as `updateDeal`'s first read returns it. */
  const existingDeal = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "d1",
    pipelineId: "p1",
    stageId: "s1",
    closedAt: null,
    amountMinor: null,
    currency: null,
    stage: stage({ id: "s1", name: "Lead" }),
    ...over,
  });

  /** The DEAL_INCLUDE-shaped row the closing `getDeal` re-read returns. */
  const fullDealRow = (over: Partial<Record<string, unknown>> = {}) => ({
    ...existingDeal(),
    title: "T",
    company: null,
    companyId: null,
    expectedCloseOn: null,
    closeReason: null,
    ownerId: null,
    projectId: null,
    origin: "LOCAL",
    externalSystem: null,
    isArchived: false,
    contactLinks: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it("does not move the stage when a later validation in the same PATCH fails", async () => {
    // The bug this pins: `moveDealStage` committed its OWN transaction, and the
    // companyId check ran AFTER it. A PATCH with a good stageId and a bad
    // companyId therefore moved the deal and wrote its STAGE_CHANGE, then threw
    // — the caller sees a 404 and assumes nothing happened while the board and
    // the forecast have already changed. A PATCH is one write; it commits once
    // or not at all.
    //
    // Mutation: move the `crmCompany.findUnique` check back below the
    // `$transaction` call → red.
    const dealUpdate = vi.fn().mockResolvedValue({});
    const activityCreate = vi.fn().mockResolvedValue({});
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ crmDeal: { update: dealUpdate }, crmActivity: { create: activityCreate } }),
    );
    const prisma = {
      crmDeal: { findUnique: vi.fn().mockResolvedValue(existingDeal()), update: dealUpdate },
      crmPipelineStage: { findUnique: async () => stage({ id: "s2", name: "Won", kind: "WON" }) },
      crmCompany: { findUnique: async () => null }, // the company does not exist
      crmActivity: { create: activityCreate },
      $transaction: transaction,
    } as never;

    await expect(
      updateDeal(prisma, "d1", { stageId: "s2", companyId: "nope" }, "user-1"),
    ).rejects.toThrow(CRM_ERRORS.COMPANY_NOT_FOUND);

    // Nothing was written at all — not the move, not the activity.
    expect(transaction).not.toHaveBeenCalled();
    expect(dealUpdate).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("applies pipelineId instead of accepting it and doing nothing", async () => {
    // `pipelineId` is accepted by dealPatchSchema (via dealCreateSchema.partial)
    // and typed on DealInput, but updateDeal never read it: PATCH {pipelineId}
    // answered 200 and left the deal where it was. Silently succeeding at
    // nothing is worse than refusing.
    //
    // Mutation: drop `pipelineId` from applyStageMove's update data → red.
    const dealUpdate = vi.fn().mockResolvedValue({});
    const activityCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      crmDeal: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(existingDeal())
          .mockResolvedValue(fullDealRow({ pipelineId: "p2", stageId: "s7" })),
        update: dealUpdate,
      },
      crmPipeline: {
        findUnique: async () => ({
          id: "p2",
          name: "Renewals",
          isDefault: false,
          sortOrder: 1,
          isArchived: false,
          // Lowest-ordered OPEN stage wins, same rule createDeal uses — so a
          // pipeline whose first column is a triage bucket does not swallow it.
          stages: [
            stage({ id: "s9", pipelineId: "p2", name: "Lost", kind: "LOST", sortOrder: 0 }),
            stage({ id: "s7", pipelineId: "p2", name: "Due", kind: "OPEN", sortOrder: 1 }),
          ],
        }),
      },
      crmPipelineStage: {
        findUnique: async () => stage({ id: "s7", pipelineId: "p2", name: "Due", kind: "OPEN" }),
      },
      crmActivity: { create: activityCreate },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ crmDeal: { update: dealUpdate }, crmActivity: { create: activityCreate } }),
      ),
    } as never;

    await updateDeal(prisma, "d1", { pipelineId: "p2" }, "user-1");

    // The stage-move write carries BOTH halves. A deal whose stageId belongs to
    // a different pipeline than its pipelineId is the one state this model must
    // never reach, so neither may be written without the other.
    const moveData = dealUpdate.mock.calls[0][0].data;
    expect(moveData.pipelineId).toBe("p2");
    expect(moveData.stageId).toBe("s7");
    expect(activityCreate.mock.calls[0][0].data.toStageId).toBe("s7");
  });

  it("validates a named stage against the pipeline being moved TO", async () => {
    // Sending {pipelineId, stageId} together used to fail with a bewildering
    // INVALID_STAGE, because moveDealStage checked the stage against the deal's
    // UNCHANGED pipeline. The stage is valid — it just belongs to the pipeline
    // the caller is moving into.
    //
    // Mutation: pass `existing.pipelineId` to requireStageInPipeline in the
    // cross-pipeline branch → red.
    const dealUpdate = vi.fn().mockResolvedValue({});
    const prisma = {
      crmDeal: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(existingDeal())
          .mockResolvedValue(fullDealRow({ pipelineId: "p2", stageId: "s7" })),
        update: dealUpdate,
      },
      crmPipeline: {
        findUnique: async () => ({
          id: "p2",
          name: "Renewals",
          isDefault: false,
          sortOrder: 1,
          isArchived: false,
          stages: [stage({ id: "s7", pipelineId: "p2", kind: "OPEN" })],
        }),
      },
      crmPipelineStage: {
        findUnique: async () => stage({ id: "s7", pipelineId: "p2", name: "Due" }),
      },
      crmActivity: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ crmDeal: { update: dealUpdate }, crmActivity: { create: vi.fn() } }),
      ),
    } as never;

    await expect(
      updateDeal(prisma, "d1", { pipelineId: "p2", stageId: "s7" }, null),
    ).resolves.toBeDefined();
    expect(dealUpdate.mock.calls[0][0].data.stageId).toBe("s7");
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

  it("guards the every-arm with `some`, so it cannot match a deal with no timeline", async () => {
    // THE POINT OF THIS FILE'S idleDays BLOCK, and the assertion it was
    // missing. The comment above named the vacuous-`every` pitfall and then
    // only checked that `every` was PRESENT — which is equally true of the
    // broken filter, so it passed against it for the whole life of the code.
    //
    // Prisma compiles `every` to `NOT EXISTS (… AND NOT cond)`, which is TRUE
    // at zero rows. Without `some: {}` the second arm matches every
    // activity-less deal regardless of age, and arm one's `createdAt` test
    // never gets to reject it — so a deal created five minutes ago comes back
    // from `idle_days=90`.
    //
    // MUTATION: drop `some: {}` from crm.service.ts and this goes red. That is
    // the whole difference between this assertion and the one above.
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { crmDeal: { findMany, count: async () => 0 } } as never;

    await listDeals(prisma, { idleDays: 90 });
    const where = findMany.mock.calls[0][0].where;
    expect(
      where.OR[1].activities.some,
      "the every-arm must be restricted to deals that HAVE activity",
    ).toEqual({});
    // And the two arms stay disjoint on the empty case: arm one owns it.
    expect(where.OR[0].activities).toEqual({ none: {} });
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

describe("deleting a synced CRM row (WARP-2554 parity)", () => {
  // There were ZERO tests on deleteCompany and deleteDeal before this. The
  // refusal they now carry is the one deleteContact has enforced since
  // WARP-2554: a synced row deleted here comes straight back on the next
  // incremental tick, and on the way out the CrmActivity cascade takes the
  // owner's own LOCAL notes with it. Archive is the action that works.

  it("refuses to delete an EXTERNAL company, and names archive as the way out", async () => {
    const del = vi.fn();
    const prisma = {
      crmCompany: {
        findUnique: async () => ({ id: "c1", origin: "EXTERNAL" }),
        delete: del,
      },
    } as never;

    await expect(deleteCompany(prisma, "c1")).rejects.toThrow(
      CRM_ERRORS.COMPANY_IS_EXTERNAL_ARCHIVE_INSTEAD,
    );
    // MUTATION: drop the guard and this is what goes red — the refusal has to
    // happen BEFORE the write, not merely be reported after it.
    expect(del).not.toHaveBeenCalled();
  });

  it("still deletes a LOCAL company", async () => {
    const del = vi.fn().mockResolvedValue({});
    const prisma = {
      crmCompany: {
        findUnique: async () => ({ id: "c2", origin: "LOCAL" }),
        delete: del,
      },
    } as never;

    await expect(deleteCompany(prisma, "c2")).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith({ where: { id: "c2" } });
  });

  it("refuses to delete an EXTERNAL deal, and names archive as the way out", async () => {
    const del = vi.fn();
    const prisma = {
      crmDeal: {
        findUnique: async () => ({ id: "d1", origin: "EXTERNAL" }),
        delete: del,
      },
    } as never;

    await expect(deleteDeal(prisma, "d1")).rejects.toThrow(
      CRM_ERRORS.DEAL_IS_EXTERNAL_ARCHIVE_INSTEAD,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it("still deletes a LOCAL deal", async () => {
    const del = vi.fn().mockResolvedValue({});
    const prisma = {
      crmDeal: {
        findUnique: async () => ({ id: "d2", origin: "LOCAL" }),
        delete: del,
      },
    } as never;

    await expect(deleteDeal(prisma, "d2")).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith({ where: { id: "d2" } });
  });

  it("selects `origin` on the deal read, or the guard reads undefined and never fires", async () => {
    // deleteDeal's find was `select: { id: true }`. A guard on a column the
    // query does not fetch is a guard that silently never fires — the failure
    // mode is invisible, so it is pinned here rather than left to review.
    const findUnique = vi.fn().mockResolvedValue({ id: "d3", origin: "LOCAL" });
    const prisma = {
      crmDeal: { findUnique, delete: vi.fn().mockResolvedValue({}) },
    } as never;

    await deleteDeal(prisma, "d3");
    expect(findUnique.mock.calls[0][0].select).toMatchObject({ origin: true });
  });
});
