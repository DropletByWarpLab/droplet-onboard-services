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

// WARP-2731 review — the Health clock. `noteTickCompleted` is module state in
// digest.js with no getter, so the call itself is the observable.
const noteTickCompletedMock = vi.hoisted(() => vi.fn());
vi.mock("../services/filing/digest.js", () => ({ noteTickCompleted: noteTickCompletedMock }));

const resolveOffLanProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../services/cloud-access.service.js", () => ({
  resolveOffLanProvider: resolveOffLanProviderMock,
  isLocalProvider: (p: string) => p === "ollama" || p === "dmr" || p === "local",
}));

import {
  runFilingTick,
  __resetInFlightForTests,
  __resetCanaryForTests,
  filingPauseState,
  CANARY_THRESHOLD,
} from "../services/filing/worker.js";
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
  __resetCanaryForTests();
  noteTickCompletedMock.mockClear();
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


// ── WARP-2731 review findings ────────────────────────────────────────────────

describe("🔴 the Health clock counts ticks the worker could not do anything with", () => {
  // The defect: `noteTickCompleted()` lived in the `finally` of the claim
  // block, which is entered only AFTER the model resolves. Every early return
  // above it — `off`, `no_owner`, `paused`, and above all `blocked` — skipped
  // it. During a sustained gateway outage every tick returns `blocked`, so
  // `lastTickAt` froze at its pre-outage value and the Health row understated
  // the outage by exactly as long as the outage lasted. That is the "a panel
  // that counted only what filing did would look healthiest the moment it
  // stopped" failure this row exists to prevent.

  it("a BLOCKED tick still stamps the clock", async () => {
    resolveOffLanProviderMock.mockResolvedValue("anthropic");
    const { prisma } = makePrisma({ setting: ENABLED, claimRows: [CLAIM_ROW] });
    expect(await runFilingTick(prisma)).toMatchObject({ status: "blocked" });
    expect(noteTickCompletedMock).toHaveBeenCalledTimes(1);
  });

  it("an OFF tick stamps it too — the worker is alive, just told to do nothing", async () => {
    const { prisma } = makePrisma({ setting: null });
    expect(await runFilingTick(prisma)).toEqual({ status: "idle", reason: "off" });
    expect(noteTickCompletedMock).toHaveBeenCalledTimes(1);
  });

  it("a processed tick still stamps it exactly once", async () => {
    completeOnceMock.mockResolvedValue({ content: "", model: "llama3:8b" });
    const { prisma } = makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      chunkRows: [{ text: "Invoice 1042 from ACME.", sensitivity: "standard" }],
    });
    await runFilingTick(prisma);
    expect(noteTickCompletedMock).toHaveBeenCalledTimes(1);
  });

  it("an in_flight tick does NOT stamp — the tick that owns the clock will", async () => {
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
    await new Promise((r) => setImmediate(r));
    expect(await runFilingTick(prisma)).toEqual({ status: "idle", reason: "in_flight" });
    expect(noteTickCompletedMock).not.toHaveBeenCalled();
    release();
    await slow;
    expect(noteTickCompletedMock).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 the five-strike canary sees a completions-only outage", () => {
  // The defect: `noteModelFailure()` had ONE call site — the pre-flight
  // `resolveFilingModel` check, which only proves the model LIST answers. A
  // gateway whose list endpoint is up while completions fail is a very
  // plausible partial outage, and it surfaces as a THROW out of
  // `extractFromText` (`askForJson` does not wrap `completeOnce`, and the
  // function's only failure reasons are `bad_json` / `phi_*` / `not_business` —
  // never `model_unreachable`). So the breaker whose doc comment promises to
  // stop exactly this could never see it, and every claimed document burned its
  // retry budget one at a time instead.

  function outage() {
    completeOnceMock.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:12434"));
    return makePrisma({
      setting: ENABLED,
      claimRows: [CLAIM_ROW],
      chunkRows: [{ text: "Invoice 1042 from ACME.", sensitivity: "standard" }],
    });
  }

  it("trips the pause after CANARY_THRESHOLD failing completions", async () => {
    const { prisma } = outage();
    expect(filingPauseState().paused).toBe(false);

    for (let i = 0; i < CANARY_THRESHOLD; i += 1) {
      // The throw is deliberately re-raised: a genuine fault reaching `safeRun`
      // is this file's contract. The canary just gets to watch it go past.
      await expect(runFilingTick(prisma)).rejects.toThrow(/ECONNREFUSED/);
    }

    expect(filingPauseState()).toEqual({ paused: true, reason: "model_unreachable" });
  });

  it("and one real answer in the middle clears the streak", async () => {
    // The counter is CONSECUTIVE failures. Without this, a box that fails four
    // times a day for two days would pause on an outage that never happened.
    const { prisma } = outage();
    for (let i = 0; i < CANARY_THRESHOLD - 1; i += 1) {
      await expect(runFilingTick(prisma)).rejects.toThrow();
    }
    expect(filingPauseState().paused).toBe(false);

    completeOnceMock.mockResolvedValue({ content: "", model: "llama3:8b" });
    await runFilingTick(prisma);

    completeOnceMock.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:12434"));
    for (let i = 0; i < CANARY_THRESHOLD - 1; i += 1) {
      await expect(runFilingTick(prisma)).rejects.toThrow();
    }
    expect(filingPauseState().paused).toBe(false);
  });
});
