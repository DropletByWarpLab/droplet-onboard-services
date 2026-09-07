/**
 * WARP-2731 review findings — the two places filing let a bookkeeping failure
 * undo, or 500, work that had already succeeded.
 *
 * 1. `recordFilingAudit` deliberately does not swallow: `cron-runtime`'s
 *    `safeRun` wants the throw so an unaudited run is counted. That default
 *    reached callers it was never designed for — three HTTP routes that mutate
 *    then audit inside one `try`, and `worker.ts`'s `finish()`, which audited
 *    BEFORE `complete()` wrote the terminal state. `recordFilingAuditBestEffort`
 *    is the seam for those.
 *
 * 2. `teachNotSame` is check-then-act. What stops a duplicate row is not the
 *    check but `FilingDecision_not_same_key` — the partial unique created with
 *    the table in WARP-2729, invisible in schema.prisma because Prisma cannot
 *    express a `WHERE` predicate. So the race loser gets P2002, and the only
 *    real defect was that an unhandled P2002 is a 500 on a button whose job is
 *    already done.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordFilingAudit, recordFilingAuditBestEffort } from "../services/filing/audit.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import { teachNotSame } from "../services/filing/rules.service.js";

const ARGS = {
  ownerId: "u-owner",
  what: "Undid a filing.",
  refs: { sourceRef: "proposal:p1", sourceKind: "FILE" as const, extractStatus: "done" as const },
};

describe("🔴 an audit write cannot undo the work it describes", () => {
  beforeEach(() => _setActivityRecorderForTests(null, null));

  it("the raw recorder still THROWS — cron's safeRun depends on it", async () => {
    // The other half of the fix. If this stops throwing, `cron-runtime` stops
    // counting unaudited runs and the best-effort wrapper becomes pointless.
    _setActivityRecorderForTests(
      { record: vi.fn(async () => { throw new Error("activity table is gone"); }) } as never,
      null,
    );
    await expect(recordFilingAudit(ARGS)).rejects.toThrow(/activity table is gone/);
  });

  it("the best-effort wrapper swallows it, so the committed action still reports success", async () => {
    _setActivityRecorderForTests(
      { record: vi.fn(async () => { throw new Error("activity table is gone"); }) } as never,
      null,
    );
    await expect(recordFilingAuditBestEffort(ARGS)).resolves.toBeUndefined();
  });

  it("and it still writes when the recorder is healthy — it is not a no-op", async () => {
    const record = vi.fn(async (_row: { kind: string; actor: { type: string; id: string } }) => {});
    _setActivityRecorderForTests({ record } as never, null);
    await recordFilingAuditBestEffort(ARGS);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      kind: "system",
      actor: { type: "ai", id: "u-owner" },
    });
  });
});

describe("🔴 'stop filing here' twice is not an error", () => {
  const INPUT = { keyKind: "EMAIL_DOMAIN" as const, keyValue: "ACME.example", companyId: "co-1" };
  const ROW = {
    id: "fd-1",
    keyKind: "EMAIL_DOMAIN",
    keyValue: "acme.example",
    verdict: "NOT_SAME",
    companyId: "co-1",
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };

  function prismaWith(over: { findFirst: unknown; create?: unknown; findFirstOrThrow?: unknown }) {
    return {
      filingDecision: {
        findFirst: over.findFirst,
        create: over.create ?? vi.fn(async () => ROW),
        findFirstOrThrow: over.findFirstOrThrow ?? vi.fn(async () => ROW),
      },
      crmCompany: { findUnique: vi.fn(async () => ({ name: "Acme" })) },
    } as never;
  }

  it("loses the check-then-act race, catches P2002 and returns the winner's row", async () => {
    // Both clicks pass `findFirst` (neither sees a row), both insert, the
    // database refuses the second. Before the fix that P2002 escaped as a 500.
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const create = vi.fn(async () => { throw p2002; });
    const findFirstOrThrow = vi.fn(async () => ROW);
    const rule = await teachNotSame(
      prismaWith({ findFirst: vi.fn(async () => null), create, findFirstOrThrow }),
      INPUT,
      "u-owner",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(rule).toMatchObject({ id: "fd-1", verdict: "NOT_SAME", companyName: "Acme" });
  });

  it("a NON-unique failure is still a real failure", async () => {
    // The guard must not become a blanket catch: a dead connection is not
    // "somebody already wrote this rule".
    const boom = Object.assign(new Error("connection terminated"), { code: "P1001" });
    await expect(
      teachNotSame(
        prismaWith({ findFirst: vi.fn(async () => null), create: vi.fn(async () => { throw boom; }) }),
        INPUT,
        "u-owner",
      ),
    ).rejects.toThrow(/connection terminated/);
  });

  it("an existing rule is returned without inserting at all", async () => {
    const create = vi.fn(async () => ROW);
    await teachNotSame(prismaWith({ findFirst: vi.fn(async () => ROW), create }), INPUT, "u-owner");
    expect(create).not.toHaveBeenCalled();
  });
});
