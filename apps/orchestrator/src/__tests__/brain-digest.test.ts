/**
 * WARP-2748 (ADR-051) — the brain service's DB-less invariants.
 *
 * The database-enforced half (the CHECK constraints, and the uniqueness that a
 * mocked client cannot prove) lives in `brain-digest.pg.test.ts`. What is here
 * is the logic a mock CAN prove and that a reviewer most needs pinned:
 *
 *   dedupe key   — the idempotency contract. If this drifts, a nightly pass
 *                  stops updating yesterday's row and starts accumulating
 *                  near-duplicates, which is the single most likely way this
 *                  feature dies in production (the operator mutes it).
 *   status       — a later pass must NOT resurrect a human's dismissal.
 *   scope filter — `company` rows are owner/admin only. This is the ADR-051
 *                  privacy line and it is a function, so it is testable here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  brainDedupeKey,
  upsertDigest,
  upsertFinding,
  visibleScopeFilter,
  setFindingStatus,
} from "../services/brain/brain-digest.service";

vi.mock("../../middleware/space", () => ({}));

// `readableDepartmentIdsFor` is the only thing the service imports from the
// space middleware, and it hits Postgres. Stubbed per-test below.
vi.mock("../middleware/space", () => ({
  readableDepartmentIdsFor: vi.fn(async () => new Set<string>()),
}));

import { readableDepartmentIdsFor } from "../middleware/space";

const SOURCES = [{ sourceKind: "file", sourceId: "1234", quote: "net 30 from delivery" }];

function digestInput(over: Record<string, unknown> = {}) {
  return {
    kind: "obligation" as const,
    title: "Acme invoices are net 30",
    body: "The 2026 MSA sets payment terms at net 30 from delivery.",
    sources: SOURCES,
    detectorKey: "obligations.terms",
    ...over,
  };
}

describe("brainDedupeKey (WARP-2748)", () => {
  it("is stable across calls for the same subject", () => {
    const a = brainDedupeKey({
      detectorKey: "money.ageing",
      kind: "loss",
      subjectType: "DEAL",
      subjectId: "d1",
    });
    const b = brainDedupeKey({
      detectorKey: "money.ageing",
      kind: "loss",
      subjectType: "DEAL",
      subjectId: "d1",
    });
    expect(a).toBe(b);
  });

  it("does NOT collapse a null subjectType onto a null subjectId", () => {
    // The reason absent components render as "-" rather than "". With "" the
    // two below both become "k:loss::x" / "k:loss:x:" -> distinct by luck of
    // ordering, but a third shape ("", "") would alias. "-" makes each slot
    // occupied, so the key is unambiguous by construction.
    const typeOnly = brainDedupeKey({
      detectorKey: "k",
      kind: "loss",
      subjectType: "DEAL",
      subjectId: null,
    });
    const idOnly = brainDedupeKey({
      detectorKey: "k",
      kind: "loss",
      subjectType: null,
      subjectId: "DEAL",
    });
    expect(typeOnly).not.toBe(idOnly);
  });

  it("separates two detectors that disagree about the same subject", () => {
    const ageing = brainDedupeKey({
      detectorKey: "money.ageing",
      kind: "loss",
      subjectType: "DEAL",
      subjectId: "d1",
    });
    const quiet = brainDedupeKey({
      detectorKey: "crm.gone-quiet",
      kind: "loss",
      subjectType: "DEAL",
      subjectId: "d1",
    });
    expect(ageing).not.toBe(quiet);
  });

  it("rejects a detector key containing the separator", () => {
    // A key with ":" could forge another detector's row.
    expect(() => brainDedupeKey({ detectorKey: "a:b", kind: "loss" })).toThrow(
      "invalid_detector_key",
    );
  });
});

describe("upsertDigest validation (WARP-2748)", () => {
  const prisma = {
    brainDigest: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "new" })),
    },
  } as never;

  it("refuses an empty sources array", async () => {
    // Mirrors BrainDigest_sources_not_empty. A digest nobody can trace to a
    // source is a hallucination with a row id.
    await expect(upsertDigest(prisma, digestInput({ sources: [] }))).rejects.toThrow(
      "evidence_required",
    );
  });

  it("refuses a source missing its quote", async () => {
    await expect(
      upsertDigest(
        prisma,
        digestInput({ sources: [{ sourceKind: "file", sourceId: "1", quote: "  " }] }),
      ),
    ).rejects.toThrow("evidence_required");
  });

  it("refuses a 0..1 confidence, which is the wrong scale", async () => {
    // 0.85 silently truncating to 0 is how a reranker logit reached the UI as
    // ~1020% in WARP-859. Integer 0-100 or nothing.
    await expect(upsertDigest(prisma, digestInput({ confidence: 0.85 }))).rejects.toThrow(
      "confidence_out_of_range",
    );
  });

  it("refuses department scope with no departmentId", async () => {
    await expect(upsertDigest(prisma, digestInput({ scope: "department" }))).rejects.toThrow(
      "scope_department_mismatch",
    );
  });

  it("refuses a departmentId on a company-scoped row", async () => {
    await expect(
      upsertDigest(prisma, digestInput({ scope: "company", departmentId: "dept-1" })),
    ).rejects.toThrow("scope_department_mismatch");
  });
});

describe("upsertFinding (WARP-2748)", () => {
  it("refuses an impact with no currency", async () => {
    const prisma = {
      brainFinding: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "f1" })),
      },
    } as never;
    await expect(
      upsertFinding(prisma, {
        kind: "loss",
        title: "t",
        rationale: "r",
        impactMinor: 4000n,
        evidence: { sources: SOURCES },
        detectorKey: "money.ageing",
      }),
    ).rejects.toThrow("impact_needs_currency");
  });

  it("does not write `status`, so a human's dismissal survives the next pass", async () => {
    // THE regression that decides whether this feature is tolerable. A pass
    // that still sees the condition must not flip a dismissed row back to
    // `new` — that is the loop arguing with the operator, and it is how a
    // nightly feature earns a mute.
    // Typed arg so `.calls[0][0]` is addressable — an untyped vi.fn() infers
    // an empty parameter tuple and tsc rejects the index.
    const upsert = vi.fn(async (_args: { update: Record<string, unknown> }) => ({ id: "f1" }));
    const prisma = {
      brainFinding: {
        findUnique: vi.fn(async () => ({ id: "f1", status: "dismissed" })),
        upsert,
      },
    } as never;

    const res = await upsertFinding(prisma, {
      kind: "loss",
      title: "t",
      rationale: "r",
      evidence: { sources: SOURCES },
      detectorKey: "money.ageing",
      subjectKey: "inv-1",
    });

    const call = upsert.mock.calls[0]![0];
    expect(call.update).not.toHaveProperty("status");
    expect(res.statusPreserved).toBe(true);
    // ...but the condition IS re-confirmed, so "still true" stays visible.
    expect(call.update).toHaveProperty("lastConfirmedAt");
  });
});

describe("visibleScopeFilter — the ADR-051 privacy line (WARP-2748)", () => {
  const prisma = {} as never;

  it("gives owner the company scope", async () => {
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u1", role: "owner" });
    expect(JSON.stringify(f)).toContain('"company"');
  });

  it("gives admin the company scope", async () => {
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u1", role: "admin" });
    expect(JSON.stringify(f)).toContain('"company"');
  });

  it("does NOT give family the company scope", async () => {
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u2", role: "family" });
    expect(JSON.stringify(f)).not.toContain('"company"');
  });

  it("does NOT give guest the company scope", async () => {
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u3", role: "guest" });
    expect(JSON.stringify(f)).not.toContain('"company"');
  });

  it("does NOT give an unknown role the company scope", async () => {
    // Fail-restrictive, the memory-audience posture: a misconfigured caller
    // can never over-read.
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u4", role: "nonsense" });
    expect(JSON.stringify(f)).not.toContain('"company"');
  });

  it("adds only the departments the caller may read", async () => {
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set(["dept-a"]));
    const f = await visibleScopeFilter(prisma, { id: "u2", role: "family" });
    const json = JSON.stringify(f);
    expect(json).toContain("dept-a");
    expect(json).not.toContain("dept-b");
  });

  it("omits the department arm entirely when the caller reads none", async () => {
    // An empty `in: []` matches nothing, but emitting it invites a later
    // refactor to treat "no departments" as "all departments".
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const f = await visibleScopeFilter(prisma, { id: "u2", role: "family" });
    expect(JSON.stringify(f)).not.toContain("department");
  });
});

describe("setFindingStatus (WARP-2748)", () => {
  it("refuses a dismissal with no reason", async () => {
    const prisma = {} as never;
    await expect(
      setFindingStatus(prisma, { id: "u1", role: "owner" }, "f1", { status: "dismissed" }),
    ).rejects.toThrow("dismissal_needs_reason");
  });

  it("refuses a dismissal whose reason is whitespace", async () => {
    const prisma = {} as never;
    await expect(
      setFindingStatus(prisma, { id: "u1", role: "owner" }, "f1", {
        status: "dismissed",
        dismissedReason: "   ",
      }),
    ).rejects.toThrow("dismissal_needs_reason");
  });

  it("refuses to move a finding the caller cannot see", async () => {
    // Guessing an id must not be a way to dismiss a company-scope finding.
    vi.mocked(readableDepartmentIdsFor).mockResolvedValueOnce(new Set<string>());
    const prisma = {
      brainFinding: { findFirst: vi.fn(async () => null), update: vi.fn() },
    } as never;
    await expect(
      setFindingStatus(prisma, { id: "u2", role: "family" }, "f-company", {
        status: "acknowledged",
      }),
    ).rejects.toThrow("finding_not_found");
    expect((prisma as unknown as { brainFinding: { update: ReturnType<typeof vi.fn> } })
      .brainFinding.update).not.toHaveBeenCalled();
  });
});
