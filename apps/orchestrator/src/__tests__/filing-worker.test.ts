/**
 * WARP-2730 (ADR-048) — the tick's own branching, on the required leg.
 *
 * `filing-loop.pg.test.ts` proves the CLAIM against a real Postgres, because
 * `FOR UPDATE SKIP LOCKED` is not a thing a stub can hold. What a stub CAN
 * hold is the order of the tick's refusals, and that order is load-bearing:
 *
 *   off            no settings row, or filing switched off  → nothing read
 *   no_owner       consent row with no enabling owner       → nothing read
 *   blocked        no usable LOCAL model                    → NOTHING CLAIMED
 *   unchanged      the fingerprint matches                  → NO MODEL CALL
 *   in_flight      a slow model must not stack ticks
 *
 * The two that matter most are `blocked` and `unchanged`, and both are
 * assertions about what did NOT happen — that no row was claimed, that no
 * completion was requested. A test that only checks the return value would
 * pass with the guard deleted.
 *
 * MUTATIONS THESE CATCH:
 *   - move `resolveFilingModel` to after the claim
 *   - delete the fingerprint comparison
 *   - delete the `inFlight` flag
 *   - let an empty owner set through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const completeOnceMock = vi.hoisted(() => vi.fn());
vi.mock("../services/llm-complete.service.js", () => ({ completeOnce: completeOnceMock }));

const listModelsMock = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-gateway.client.js", () => ({
  listModels: listModelsMock,
  chat: vi.fn(),
  isTimeoutError: () => false,
}));

const resolveOffLanProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../services/cloud-access.service.js", () => ({
  resolveOffLanProvider: resolveOffLanProviderMock,
  isLocalProvider: (p: string) => p === "ollama" || p === "dmr" || p === "local",
}));

import { runFilingTick, __resetInFlightForTests } from "../services/filing/worker.js";
import { fingerprintChunks } from "../services/filing/read-content.js";

const ENABLED = {
  id: "singleton",
  mode: "propose",
  level: "links_only",
  vertical: "general",
  enabledById: "u-owner",
  enabledAt: new Date("2026-01-01T00:00:00Z"),
  folders: [],
  pathDenylist: null,
  hourlyApplyCap: 50,
  dailyCreateCap: 10,
};

const CLAIM_ROW = {
  userId: "stefan",
  path: "/Customers/acme-invoice.pdf",
  ncFileId: 8891,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  extractFingerprint: "c1:deadbeef",
};

/**
 * A prisma stub shaped to the tick's actual reads.
 *
 * `$transaction` runs the callback with the same stub, so `claimOne`'s raw
 * SELECT and its guarded `updateMany` both land on the counters below —
 * which is how "nothing was claimed" becomes assertable.
 */
function makePrisma(over: {
  setting?: unknown;
  claimRows?: unknown[];
  chunkRows?: { text: string; sensitivity: string }[];
  claimCount?: number;
}) {
  const queryRaw = vi.fn(async () => over.claimRows ?? []);
  const updateMany = vi.fn(async () => ({ count: over.claimCount ?? 1 }));
  const prisma: Record<string, unknown> = {
    autoFilingSetting: { findUnique: vi.fn(async () => over.setting ?? null) },
    user: { findUnique: vi.fn(async () => ({ username: "stefan" })) },
    workspaceSetting: { findUnique: vi.fn(async () => ({ valueJson: "llama3:8b" })) },
    fileIndexStatus: {
      updateMany,
      findUnique: vi.fn(async () => ({ extractAttempts: 1 })),
    },
    // The claim's raw SELECT and the chunk read share one seam, so they are
    // dispatched on the SQL text. `$queryRaw` is a tagged template: the first
    // argument is the TemplateStringsArray itself, not an object wrapping it —
    // reading `args[0].strings` silently matches nothing and hands the chunk
    // read the CLAIM rows, which is a stub bug that looks like a code bug.
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      const sql = Array.isArray(args[0]) ? (args[0] as string[]).join(" ") : String(args[0]);
      if (sql.includes("FileContentChunk")) return over.chunkRows ?? [];
      return queryRaw();
    }),
    filingDecision: { findMany: vi.fn(async () => []) },
    ingestProposal: { create: vi.fn(async () => ({ id: "p1" })) },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma: prisma as never, queryRaw, updateMany };
}

beforeEach(() => {
  __resetInFlightForTests();
  completeOnceMock.mockReset();
  listModelsMock.mockReset();
  resolveOffLanProviderMock.mockReset();
  resolveOffLanProviderMock.mockResolvedValue(null);
  listModelsMock.mockResolvedValue({
    models: [{ id: "llama3:8b", name: "llama3:8b", provider: "ollama" }],
  });
});

describe("the tick refuses in order", () => {
  it("no settings row is OFF, and reads nothing else", async () => {
    const { prisma, queryRaw } = makePrisma({ setting: null });
    expect(await runFilingTick(prisma)).toEqual({ status: "idle", reason: "off" });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("MUTATION: let an empty owner set through — the worker reads every owner's files", async () => {
    const { prisma, queryRaw } = makePrisma({
      setting: { ...ENABLED, enabledById: null },
    });
    expect(await runFilingTick(prisma)).toEqual({ status: "idle", reason: "no_owner" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("MUTATION: resolve the model AFTER the claim — a cloud box marks its whole corpus", async () => {
    // The order is the guard. Resolving after the claim would consume a row
    // per tick and mark each one `failed`, turning a one-line settings mistake
    // into thousands of rows to re-arm.
    resolveOffLanProviderMock.mockResolvedValue("anthropic");
    const { prisma, queryRaw, updateMany } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
    });
    expect(await runFilingTick(prisma)).toMatchObject({
      status: "blocked",
      reason: "cloud_model_refused",
    });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("nothing pending is idle, not an error", async () => {
    const { prisma } = makePrisma({ setting: ENABLED, claimRows: [] });
    expect(await runFilingTick(prisma)).toEqual({
      status: "idle",
      reason: "nothing_pending",
    });
  });

  it("losing the claim race is idle too — the guard is the count", async () => {
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      claimCount: 0,
    });
    expect(await runFilingTick(prisma)).toEqual({
      status: "idle",
      reason: "nothing_pending",
    });
    expect(completeOnceMock).not.toHaveBeenCalled();
  });
});

describe("🔴 an unchanged file costs nothing", () => {
  const BODY = "Invoice 1042 from ACME Dental Supply Ltd. Total $4,250.00 USD.";

  it("MUTATION: delete the fingerprint comparison — a chown re-extracts the corpus", async () => {
    // `set_index_status` bumps `updatedAt` on EVERY upsert, including a
    // metadata-only touch. Without this comparison a `chown -R`, a restic
    // restore or an `occ files:scan` re-reads every document on the box
    // through the model.
    //
    // The stored fingerprint is computed with the SAME function the worker
    // uses rather than hard-coded: a literal here would still pass with the
    // hash changed on both sides, which is the shape of a test that proves the
    // constant and not the guard.
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [{ ...CLAIM_ROW, extractFingerprint: fingerprintChunks([BODY]) }],
      chunkRows: [{ text: BODY, sensitivity: "standard" }],
    });

    expect(await runFilingTick(prisma)).toMatchObject({
      status: "processed",
      extractStatus: "done",
      extractReason: "unchanged",
    });
    // The assertion that matters.
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("a CHANGED fingerprint does reach the model", async () => {
    // The other half. Without it the test above passes with the whole
    // extraction deleted.
    completeOnceMock.mockResolvedValue({ content: "", model: "llama3:8b" });
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [{ ...CLAIM_ROW, extractFingerprint: fingerprintChunks(["something else"]) }],
      chunkRows: [{ text: BODY, sensitivity: "standard" }],
    });
    await runFilingTick(prisma);
    expect(completeOnceMock).toHaveBeenCalled();
  });
});

describe("🔴 a slow model does not stack ticks", () => {
  it("MUTATION: delete the inFlight flag — two ticks read the same file at once", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    completeOnceMock.mockImplementation(async () => {
      await held;
      return { content: "", model: "llama3:8b" };
    });

    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      chunkRows: [{ text: "Invoice 1042 from ACME.", sensitivity: "standard" }],
    });

    const slow = runFilingTick(prisma);
    // Let the first tick reach the model call before the second starts.
    await new Promise((r) => setImmediate(r));
    const second = await runFilingTick(prisma);
    expect(second).toEqual({ status: "idle", reason: "in_flight" });

    release();
    await slow;
  });
});

describe("a document with no readable text is not a failure", () => {
  it("is `not_needed/no_text`, and never reaches the model", async () => {
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      chunkRows: [],
    });
    expect(await runFilingTick(prisma)).toMatchObject({
      status: "processed",
      extractStatus: "not_needed",
      extractReason: "no_text",
    });
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("an encrypted chunk is refused rather than extracted from base64", async () => {
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      chunkRows: [{ text: "dcv1:AAAA", sensitivity: "sensitive" }],
    });
    expect(await runFilingTick(prisma)).toMatchObject({
      extractStatus: "not_needed",
      extractReason: "encrypted_content",
    });
    expect(completeOnceMock).not.toHaveBeenCalled();
  });
});

describe("the folder fence stops a claim before it is read", () => {
  it("a file outside the owner's folders is `not_needed/out_of_scope`", async () => {
    const { prisma } = makePrisma({
      setting: { ...ENABLED, folders: ["/Customers"] },
      claimRows: [{ ...CLAIM_ROW, path: "/Personal/payslip.pdf" }],
      chunkRows: [{ text: "anything at all", sensitivity: "standard" }],
    });
    expect(await runFilingTick(prisma)).toMatchObject({
      extractStatus: "not_needed",
      extractReason: "out_of_scope",
    });
    expect(completeOnceMock).not.toHaveBeenCalled();
  });
});
