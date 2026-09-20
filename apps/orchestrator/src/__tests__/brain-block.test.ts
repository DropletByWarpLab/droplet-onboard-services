/**
 * WARP-2752 (ADR-051) — the brain block.
 *
 * The prompt-injected read path: the model knows on turn one without spending
 * one of its ten iterations on a tool call. Three properties decide whether
 * that is safe rather than merely useful:
 *
 *   scope     a `company` row must never reach a family turn, INCLUDING down
 *             the error path — an enhancement that fails open is a leak
 *   bounded   the block is capped at build time, so every downstream token
 *             estimate is a measurement rather than a guess
 *   honest    it must tell the model this is a partial standing summary, or
 *             the model will answer "I reviewed all your documents" on the
 *             strength of eight digests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const visibleScopeFilter = vi.hoisted(() => vi.fn(async () => ({ OR: [{ scope: "personal" }] })));
vi.mock("../services/brain/brain-digest.service.js", () => ({ visibleScopeFilter }));
vi.mock("../services/brain/brain-digest.service", () => ({ visibleScopeFilter }));

// WARP-2876 — the consent switch. Mocked here rather than driven through
// `config` + a `brainSetting` row because `brain-switch.test.ts` already owns
// which of the two sources decides; what this file owns is that the block
// OBEYS whatever that resolution answers.
const isBrainEnabled = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../services/brain/brain-switch.service.js", () => ({ isBrainEnabled }));
vi.mock("../services/brain/brain-switch.service", () => ({ isBrainEnabled }));

import {
  buildBrainBlock,
  BRAIN_BLOCK_CHAR_BUDGET,
} from "../services/brain/brain-block.service";

function db(findings: unknown[] = [], digests: unknown[] = []) {
  return {
    brainFinding: { findMany: vi.fn(async () => findings) },
    brainDigest: { findMany: vi.fn(async () => digests) },
  } as never;
}

const owner = { id: "u1", role: "owner" };

const digest = {
  title: "Acme invoices are net 30",
  body: "The 2026 MSA sets payment terms at net 30 from delivery.",
};
const finding = {
  title: "Acme is 90 days past due",
  kind: "loss",
  impactMinor: 4_000_000n,
  currency: "USD",
};

beforeEach(() => {
  isBrainEnabled.mockResolvedValue(true);
  visibleScopeFilter.mockResolvedValue({ OR: [{ scope: "personal" }] });
});

/**
 * WARP-2876 — the consent gate.
 *
 * THE DEFECT THIS PINS. `buildBrainBlock` never asked whether the brain was
 * on. The pass-trigger path did (`index.ts` `preconditions`), so revoking
 * consent stopped the box WRITING new rows — and left every chat turn still
 * being handed a system-prompt block built from the rows written before the
 * revocation. The owner's click stopped the reading and not the telling, which
 * is the half that reaches the model.
 *
 * WHY THE GATE IS IN THIS FUNCTION and not at the two call sites: `routes/llm.ts`
 * and `prompt-inspect.service.ts` both funnel through here, and a third caller
 * is the likely shape of the next regression. One guard where they meet.
 *
 * 🔴 THIS IS A SERVE GATE, NOT A DELETE. The rows survive, deliberately — see
 * the service docstring and ADR-051 §9.9.
 */
describe("the consent switch (WARP-2876)", () => {
  it("🔴 serves NOTHING while the brain is off, even with rows sitting there", async () => {
    isBrainEnabled.mockResolvedValue(false);
    const prisma = db([finding], [digest]);
    expect(await buildBrainBlock(prisma, owner)).toBe("");
  });

  it("🔴 does not even READ the rows while the brain is off", async () => {
    // Belt and braces: a block assembled and then thrown away still pulled
    // revoked-consent content into this process. Nothing should be fetched.
    isBrainEnabled.mockResolvedValue(false);
    const prisma = db([finding], [digest]) as unknown as Record<
      string,
      { findMany: ReturnType<typeof vi.fn> }
    >;
    await buildBrainBlock(prisma as never, owner);
    expect(prisma.brainFinding!.findMany).not.toHaveBeenCalled();
    expect(prisma.brainDigest!.findMany).not.toHaveBeenCalled();
    // The scope filter is downstream of the gate, so it must not run either.
    expect(visibleScopeFilter).not.toHaveBeenCalled();
  });

  it("sends NO block when the switch itself cannot be read", async () => {
    // Same posture as the unresolvable-scope case below: an enhancement that
    // fails OPEN on a consent question serves content nobody has consented to.
    isBrainEnabled.mockRejectedValueOnce(new Error("db down"));
    expect(await buildBrainBlock(db([finding], [digest]), owner)).toBe("");
  });

  it("serves again once the brain is switched back on", async () => {
    // The off state must be a gate and not a one-way door — the rows were
    // never deleted, so flipping the switch back restores the block as it was.
    isBrainEnabled.mockResolvedValue(true);
    const out = await buildBrainBlock(db([finding], [digest]), owner);
    expect(out).toContain("net 30");
    expect(out).toContain("Acme is 90 days past due");
  });

  it("asks PER CALL, never once — the switch is a row that changes under us", async () => {
    const prisma = db([finding], [digest]);
    await buildBrainBlock(prisma, owner);
    isBrainEnabled.mockResolvedValue(false);
    expect(await buildBrainBlock(prisma, owner)).toBe("");
  });
});

describe("buildBrainBlock (WARP-2752)", () => {
  it("returns EMPTY when there is nothing known", async () => {
    // An empty heading with no items under it is worse than no block: it
    // spends prompt budget to tell the model nothing.
    expect(await buildBrainBlock(db(), owner)).toBe("");
  });

  it("renders digests and findings", async () => {
    const out = await buildBrainBlock(db([finding], [digest]), owner);
    expect(out).toContain("net 30");
    expect(out).toContain("Acme is 90 days past due");
  });

  it("renders money in MAJOR units with its currency", async () => {
    const out = await buildBrainBlock(db([finding], []), owner);
    // 4,000,000 minor = 40000.00 USD, via the currency-aware
    // `formatMinorUnits`. The raw minor figure would overstate by 100x, and a
    // hardcoded /100 would understate JPY by the same factor.
    expect(out).toContain("40000.00 USD");
    expect(out).not.toContain("4000000 USD");
  });

  it("uses the currency's own exponent for a 0-decimal currency", async () => {
    const out = await buildBrainBlock(
      db([{ ...finding, impactMinor: 1000n, currency: "JPY" }], []),
      owner,
    );
    // JPY has no minor unit: 1000 minor IS 1000 yen, not 10.
    expect(out).toContain("1000 JPY");
  });

  it("omits money entirely when the detector computed none", async () => {
    const out = await buildBrainBlock(
      db([{ ...finding, impactMinor: null, currency: null }], []),
      owner,
    );
    expect(out).toContain("Acme is 90 days past due");
    expect(out).not.toContain("USD");
  });

  it("tells the model the summary is standing and PARTIAL", async () => {
    // Without this the model says "I have reviewed all your documents" on the
    // strength of eight digests, which is lying on the box's behalf.
    const out = await buildBrainBlock(db([], [digest]), owner);
    expect(out).toContain("not a live read");
    expect(out).toContain("partial");
    expect(out).toContain("business_find");
  });

  it("stays within the char budget, clipped at a line boundary", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `Digest ${i} ${"x".repeat(200)}`,
      body: "y".repeat(400),
    }));
    const out = await buildBrainBlock(db([], many), owner);
    expect(out.length).toBeLessThanOrEqual(BRAIN_BLOCK_CHAR_BUDGET);
    // Clipped at a newline, so the last line is never half a sentence the
    // model might finish for itself.
    expect(out.endsWith("\n")).toBe(false);
    expect(out.split("\n").pop()).not.toMatch(/^-\s*$/);
  });

  it("reads only OPEN findings", async () => {
    const prisma = db([], []);
    await buildBrainBlock(prisma, owner);
    const where = (
      prisma as unknown as { brainFinding: { findMany: { mock: { calls: [{ where: { status: string } }][] } } } }
    ).brainFinding.findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("new");
  });

  it("excludes superseded digests", async () => {
    const prisma = db([], []);
    await buildBrainBlock(prisma, owner);
    const where = (
      prisma as unknown as {
        brainDigest: { findMany: { mock: { calls: [{ where: { supersededById: null } }][] } } };
      }
    ).brainDigest.findMany.mock.calls[0]![0].where;
    expect(where.supersededById).toBeNull();
  });

  it("sends NO block when scope cannot be resolved — never an unscoped one", async () => {
    // The failure that would matter: an enhancement failing open shows a
    // family member company-wide findings.
    visibleScopeFilter.mockRejectedValueOnce(new Error("boom"));
    const prisma = db([finding], [digest]);
    expect(await buildBrainBlock(prisma, { id: "u2", role: "family" })).toBe("");
    expect(
      (prisma as unknown as { brainFinding: { findMany: ReturnType<typeof vi.fn> } })
        .brainFinding.findMany,
    ).not.toHaveBeenCalled();
  });

  it("applies the caller's scope filter to BOTH reads", async () => {
    const prisma = db([], []);
    await buildBrainBlock(prisma, owner);
    for (const model of ["brainFinding", "brainDigest"] as const) {
      const call = (
        prisma as unknown as Record<string, { findMany: { mock: { calls: [{ where: unknown }][] } } }>
      )[model]!.findMany.mock.calls[0]![0];
      expect(JSON.stringify(call.where)).toContain("personal");
    }
  });
});
