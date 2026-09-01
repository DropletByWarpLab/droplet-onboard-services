/**
 * WARP-2546 — the `crm_*` tools.
 *
 * Mocks `ctx.http.orchestrator` the way `pm-handlers.test.ts` does. The
 * assertions worth having here are the ones a registry test cannot make: that
 * money survives the round trip as a string, that the write tools are gated,
 * that the model-writable timeline vocabulary excludes the box-written kinds,
 * and that a mixed-currency stage is reported as unsummed rather than as zero.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ADR-045 slice C — the five CRM READ handlers were replaced by
// `business_find` / `business_timeline`. Their coverage (money as a string,
// provenance from `origin`, the unsummed mixed-currency stage, the declared
// hop list) moved WITH them, to __tests__/handlers/business/business-graph.
// test.ts — it was not dropped. What remains here is the two write tools.
import type { ToolContext } from "../../../src/types.js";
import crmLogActivity from "../../../src/handlers/crm/log-activity.js";
import crmMoveDealStage from "../../../src/handlers/crm/move-deal-stage.js";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const ctx = {
  http: { orchestrator: { get, post, patch, delete: del } },
} as unknown as ToolContext;

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

const apiCompany = {
  id: "c1",
  name: "Example Roofing",
  domain: "example.com",
  industry: "Construction",
  openDealCount: 2,
  contactCount: 3,
  origin: "LOCAL",
  externalSystem: null,
};

const apiDeal = {
  id: "d1",
  title: "Annual contract",
  companyName: "Example Roofing",
  stage: { name: "Closed — signed", kind: "WON" },
  amountMinor: "9007199254740993",
  currency: "USD",
  expectedCloseOn: null,
  closedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read tools", () => {
  it("there are none left in this suite — the CRM reads are the business graph now", () => {
    // ADR-045 slice C. Kept as a signpost rather than an empty file: the next
    // person looking for "where did crm_get_customer's tests go" finds the
    // answer here instead of in a git log.
    expect(crmLogActivity.requiresWrite).toBe(true);
    expect(crmMoveDealStage.requiresWrite).toBe(true);
  });
});

describe("write tools", () => {
  it("both declare write intent and confirmation", () => {
    // The dispatch interceptor (WARP-2305) enforces the flag generically, so
    // the flag IS the gate — there is no handler-side check to test, and that
    // makes this assertion the one that matters.
    for (const tool of [crmLogActivity, crmMoveDealStage]) {
      expect(tool.requiresWrite, tool.name).toBe(true);
      expect(tool.requiresConfirmation, tool.name).toBe(true);
    }
  });

  it("crm_log_activity cannot write the box-written timeline kinds", () => {
    // A model-written STAGE_CHANGE with no move behind it would make the
    // timeline lie about the pipeline. The orchestrator enforces the same list;
    // this is the first gate, not the only one.
    const kinds = (
      crmLogActivity.inputSchema as { properties: { kind: { enum: string[] } } }
    ).properties.kind.enum;
    expect(kinds).toEqual(["NOTE", "CALL", "MEETING", "TASK", "EMAIL"]);
    expect(kinds).not.toContain("STAGE_CHANGE");
    expect(kinds).not.toContain("CREATED");
    expect(kinds).not.toContain("SYNCED");
  });

  it("crm_log_activity sends the subject on the matching column only", async () => {
    post.mockResolvedValue(
      res(true, 200, { activity: { id: "a1", kind: "CALL", summary: "Called", occurredAt: "2026-08-29T00:00:00.000Z" } }),
    );
    await crmLogActivity.handler(
      { subject_type: "DEAL", subject_id: "d1", kind: "CALL", summary: "Called" },
      ctx,
    );
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ subjectType: "DEAL", dealId: "d1", companyId: null });
  });

  it("crm_move_deal_stage posts to the stage route, not a generic patch", async () => {
    // PATCHing stageId would move the deal without the STAGE_CHANGE timeline
    // entry the dedicated route writes.
    post.mockResolvedValue(res(true, 200, { deal: apiDeal }));
    await crmMoveDealStage.handler({ deal_id: "d1", stage_id: "s2" }, ctx);
    expect(post.mock.calls[0][0]).toBe("/api/crm/deals/d1/stage");
    expect(post.mock.calls[0][1]).toEqual({ stageId: "s2" });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("separates a missing record from a wrong-but-real one", async () => {
    // 404 lets the model say "I couldn't find that deal"; 422 (a stage from
    // another pipeline) is a fixable mistake it can act on. Collapsing both
    // into one code makes the second unrecoverable.
    // ADR-045 slice C — driven through `crm_move_deal_stage` now that the
    // reads have moved to the business graph. `crmError()` is one shared
    // mapping for every crm_* handler, so which surviving tool exercises it
    // does not matter; that it is still exercised does.
    post.mockResolvedValue(res(false, 404, { error: "deal_not_found" }));
    const missing = await crmMoveDealStage.handler({ deal_id: "nope", stage_id: "s2" }, ctx);
    expect(missing.ok).toBe(false);
    expect((missing as { error: { code: string } }).error.code).toBe("CRM_NOT_FOUND");

    post.mockResolvedValue(res(false, 422, { error: "invalid_stage" }));
    const wrong = await crmMoveDealStage.handler({ deal_id: "d1", stage_id: "sX" }, ctx);
    expect((wrong as { error: { code: string; message: string } }).error.code).toBe(
      "CRM_INVALID_REQUEST",
    );
    expect((wrong as { error: { message: string } }).error.message).toBe("invalid_stage");
  });

  it("maps anything else to a generic API error", async () => {
    post.mockResolvedValue(res(false, 500, { error: "boom" }));
    const out = await crmLogActivity.handler(
      { kind: "NOTE", summary: "x", customer_id: "c1" },
      ctx,
    );
    expect((out as { error: { code: string } }).error.code).toBe("CRM_API_ERROR");
  });
});
