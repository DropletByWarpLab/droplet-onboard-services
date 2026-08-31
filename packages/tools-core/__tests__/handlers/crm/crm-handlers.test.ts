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

import type { ToolContext } from "../../../src/types.js";
import crmSearchCustomers from "../../../src/handlers/crm/search-customers.js";
import crmGetCustomer from "../../../src/handlers/crm/get-customer.js";
import crmListDeals from "../../../src/handlers/crm/list-deals.js";
import crmGetDeal from "../../../src/handlers/crm/get-deal.js";
import crmPipelineSummary from "../../../src/handlers/crm/pipeline-summary.js";
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
  it("are all read-only and ungated", () => {
    for (const tool of [
      crmSearchCustomers,
      crmGetCustomer,
      crmListDeals,
      crmGetDeal,
      crmPipelineSummary,
    ]) {
      expect(tool.requiresWrite, tool.name).toBe(false);
      expect(tool.requiresConfirmation, tool.name).toBe(false);
    }
  });

  it("crm_search_customers returns the total alongside the page", async () => {
    // Without the total the model answers "you have 20 customers" whenever the
    // page is full, which is wrong exactly when it matters.
    get.mockResolvedValue(res(true, 200, { companies: [apiCompany], total: 137 }));
    const out = await crmSearchCustomers.handler({ query: "roof" }, ctx);
    expect(out.ok).toBe(true);
    expect((out.data as { total: number }).total).toBe(137);
    expect(get.mock.calls[0][0]).toContain("q=roof");
    expect(get.mock.calls[0][0]).toContain("per_page=20");
  });

  it("reports provenance from origin, not from the presence of an external id", async () => {
    get.mockResolvedValue(
      res(true, 200, {
        companies: [{ ...apiCompany, origin: "LOCAL", externalSystem: "hubspot" }],
        total: 1,
      }),
    );
    const out = await crmSearchCustomers.handler({}, ctx);
    const first = (out.data as { customers: Array<{ synced_from: string | null }> }).customers[0];
    // origin is the explicit column; a stray externalSystem on a LOCAL row is
    // data corruption, not a reason to tell the model the row is synced.
    expect(first.synced_from).toBeNull();
  });

  it("carries a deal amount past 2^53 through as an untouched string", async () => {
    // 9007199254740993 minor units. If anything on this path treated it as a
    // number it would come back 9007199254740992 — off by one, in a figure
    // somebody is about to quote to a customer.
    get.mockResolvedValue(res(true, 200, { deals: [apiDeal], total: 1 }));
    const out = await crmListDeals.handler({ outcome: "WON" }, ctx);
    const deal = (out.data as { deals: Array<{ amount_minor: string; outcome: string }> }).deals[0];
    expect(deal.amount_minor).toBe("9007199254740993");
    expect(typeof deal.amount_minor).toBe("string");
    // Outcome comes from stage.kind — the stage NAME here is "Closed — signed",
    // which no string match would classify.
    expect(deal.outcome).toBe("WON");
  });

  it("filters deals by outcome and idle days on the request, not after the fact", async () => {
    get.mockResolvedValue(res(true, 200, { deals: [], total: 0 }));
    await crmListDeals.handler({ outcome: "OPEN", idle_days: 14, customer_id: "c1" }, ctx);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("kind=OPEN");
    expect(url).toContain("idle_days=14");
    expect(url).toContain("company=c1");
  });

  it("crm_get_customer declares all three of the calls it makes", async () => {
    // The completeness gate checks the declared hop LIST. This asserts the
    // handler really does make the three calls tool-routes.ts claims.
    get.mockImplementation(async (url: string) => {
      if (url.includes("/companies/")) return res(true, 200, { company: apiCompany });
      if (url.includes("/deals")) return res(true, 200, { deals: [apiDeal] });
      return res(true, 200, { activities: [] });
    });
    const out = await crmGetCustomer.handler({ customer_id: "c1" }, ctx);
    expect(out.ok).toBe(true);
    const urls = get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/crm/companies/c1"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/crm/deals?company=c1&kind=OPEN"))).toBe(true);
    expect(urls.some((u) => u.includes("subject_type=COMPANY"))).toBe(true);
  });

  it("crm_get_deal asks for the deal and its timeline", async () => {
    get.mockImplementation(async (url: string) =>
      url.includes("/activities")
        ? res(true, 200, { activities: [{ id: "a1", kind: "NOTE", summary: "Called", occurredAt: "2026-08-02T00:00:00.000Z" }] })
        : res(true, 200, { deal: apiDeal }),
    );
    const out = await crmGetDeal.handler({ deal_id: "d1" }, ctx);
    expect(out.ok).toBe(true);
    const data = out.data as { timeline: Array<{ summary: string }> };
    expect(data.timeline[0].summary).toBe("Called");
  });

  it("crm_pipeline_summary withholds a mixed-currency total instead of reporting zero", async () => {
    // The server sends amountMinor "0" with currency null for a mixed stage.
    // Passing that through would read as an empty stage.
    get.mockResolvedValue(
      res(true, 200, {
        pipelineId: "p1",
        stages: [
          { stageId: "s1", stageName: "Lead", kind: "OPEN", sortOrder: 0, dealCount: 3, valuation: "mixed_currencies", amountMinor: "0", currency: null },
          { stageId: "s2", stageName: "Won", kind: "WON", sortOrder: 1, dealCount: 1, valuation: "priced", amountMinor: "250000", currency: "USD" },
        ],
      }),
    );
    const out = await crmPipelineSummary.handler({}, ctx);
    const stages = (out.data as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages[0]).toMatchObject({ deals: 3, total: null });
    expect(stages[0].total_note).toContain("mixed currencies");
    expect(stages[0]).not.toHaveProperty("amount_minor");
    expect(stages[1]).toMatchObject({ amount_minor: "250000", currency: "USD" });
  });

  it("crm_pipeline_summary tells an unpriced stage apart from a mixed-currency one", async () => {
    // WARP-2556 — the two used to arrive in the SAME wire shape
    // (`amountMinor: "0"`, `currency: null`), and this handler branched on the
    // null. So a stage of deals nobody had priced yet — the ordinary state of
    // an early pipeline on a new box — was reported to the model as holding
    // mixed currencies. The model then told the owner something that was not
    // merely vague but false.
    //
    // Mutation: collapse the `unpriced` arm into the `mixed_currencies` one in
    // pipeline-summary.ts → this goes red on the note.
    get.mockResolvedValue(
      res(true, 200, {
        pipelineId: "p1",
        stages: [
          { stageId: "s1", stageName: "Lead", kind: "OPEN", sortOrder: 0, dealCount: 4, valuation: "unpriced", amountMinor: "0", currency: null },
          { stageId: "s2", stageName: "Qualified", kind: "OPEN", sortOrder: 1, dealCount: 2, valuation: "mixed_currencies", amountMinor: "0", currency: null },
        ],
      }),
    );
    const out = await crmPipelineSummary.handler({}, ctx);
    const stages = (out.data as { stages: Array<Record<string, unknown>> }).stages;

    // Both withhold a total — that part was always right.
    expect(stages[0]).toMatchObject({ deals: 4, total: null });
    expect(stages[1]).toMatchObject({ deals: 2, total: null });

    // What changed: they no longer say the same thing about WHY.
    expect(stages[0].total_note).toBe("no amounts entered yet");
    expect(stages[1].total_note).toBe("mixed currencies — not summed");
    expect(stages[0].total_note).not.toBe(stages[1].total_note);
    expect(stages[0].total_note).not.toContain("currenc");
  });

  it("crm_pipeline_summary reads the state, not the null", async () => {
    // The guard against a well-meaning revert to `s.currency === null`: a
    // PRICED stage is allowed to carry a null currency on the wire without
    // being reclassified. Nothing produces that today, which is the point —
    // the handler must not re-derive a state it is now told outright.
    get.mockResolvedValue(
      res(true, 200, {
        pipelineId: "p1",
        stages: [
          { stageId: "s1", stageName: "Lead", kind: "OPEN", sortOrder: 0, dealCount: 1, valuation: "priced", amountMinor: "1500", currency: null },
        ],
      }),
    );
    const out = await crmPipelineSummary.handler({}, ctx);
    const stages = (out.data as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages[0]).toMatchObject({ amount_minor: "1500" });
    expect(stages[0]).not.toHaveProperty("total_note");
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
    get.mockResolvedValue(res(false, 404, { error: "deal_not_found" }));
    const missing = await crmGetDeal.handler({ deal_id: "nope" }, ctx);
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
    get.mockResolvedValue(res(false, 500, { error: "boom" }));
    const out = await crmListDeals.handler({}, ctx);
    expect((out as { error: { code: string } }).error.code).toBe("CRM_API_ERROR");
  });
});
