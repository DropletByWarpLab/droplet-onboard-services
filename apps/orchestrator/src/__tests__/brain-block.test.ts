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
import { describe, it, expect, vi } from "vitest";

const visibleScopeFilter = vi.hoisted(() => vi.fn(async () => ({ OR: [{ scope: "personal" }] })));
vi.mock("../services/brain/brain-digest.service.js", () => ({ visibleScopeFilter }));
vi.mock("../services/brain/brain-digest.service", () => ({ visibleScopeFilter }));

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

  it("renders money in whole units with its currency", async () => {
    const out = await buildBrainBlock(db([finding], []), owner);
    // 4,000,000 minor = 40000 USD. Prompt text, so no separators — but it must
    // not be the raw minor figure, which would overstate by 100x.
    expect(out).toContain("40000 USD");
    expect(out).not.toContain("4000000");
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
