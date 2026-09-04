/**
 * ADR-045 slice C — the two business graph reads.
 *
 * Mocks `ctx.http.orchestrator` the way `crm-handlers.test.ts` and
 * `pm-handlers.test.ts` do. The assertions worth having here are the ones no
 * registry gate can make: that the CALLS are the ones the manifest declares,
 * that money survives the round trip as a string, that a misused argument is
 * refused by name instead of silently ignored, that a customer's delivery work
 * costs ONE extra request and not one per deal, that a disabled module reads
 * as a switch and not as a missing customer, and that a PM comment appears
 * once rather than twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ToolContext } from "../../../src/types.js";
import { expectOk } from "../../helpers/tool-result.js";
import businessFind from "../../../src/handlers/business/find.js";
import businessTimeline from "../../../src/handlers/business/timeline.js";

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
  projectId: "p1",
};

const apiContact = {
  id: "ct1",
  displayName: "Dana Okafor",
  organization: "Example Roofing",
  jobTitle: "Estimator",
  titleAtCompany: "Signatory",
  emails: [{ address: "dana@example.com", isPrimary: true }],
  phones: [{ number: "+15550100", isPrimary: true }],
  origin: "LOCAL",
  externalSystem: null,
  companyIds: ["c1"],
  dealIds: ["d1"],
};

const apiProject = { id: "p1", name: "Roof replacement", identifier: "ROOF", workspaceSlug: "main" };

const apiWorkItem = {
  id: "w1",
  name: "Order tiles",
  descriptionHtml: "<p>Ridge tiles, 40 boxes.</p>",
  stateId: "s1",
  state: { name: "In Progress" },
  assignees: ["u1"],
  labels: [{ name: "materials" }],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tier", () => {
  it("both graph reads are read-only and ungated", () => {
    for (const tool of [businessFind, businessTimeline]) {
      expect(tool.requiresWrite, tool.name).toBe(false);
      expect(tool.requiresConfirmation, tool.name).toBe(false);
    }
  });
});

describe("business_find — the discriminator", () => {
  it("refuses an entity outside the vocabulary, by name", async () => {
    // The schema `enum` is the first gate; this is the second, and it is the
    // ONLY one on the plain-string fallback path documented in find.ts.
    // Mutation: delete the FIND_ENTITIES check → this returns a 404 from an
    // orchestrator call that should never have been made.
    const out = await businessFind.handler({ entity: "invoice" }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: { code: string; message: string } }).error.code).toBe(
      "BUSINESS_INVALID_REQUEST",
    );
    expect((out as { error: { message: string } }).error.message).toContain("work_item");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an argument the entity cannot honour instead of ignoring it", async () => {
    // Silently dropping `idle_days` on a work-item search looks like an answer
    // and is a lie — the model would report "nothing is stale" having never
    // asked. Mutation: make rejectMisusedArgs return null always → green here,
    // and the tool starts lying.
    const out = await businessFind.handler({ entity: "work_item", idle_days: 14 }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: { message: string } }).error.message).toContain("idle_days");
    expect(get).not.toHaveBeenCalled();
  });

  it("uppercases a lowercase status rather than passing it through", async () => {
    get.mockResolvedValue(res(true, 200, { deals: [], total: 0 }));
    await businessFind.handler({ entity: "deal", status: "open" }, ctx);
    expect(get.mock.calls[0][0]).toContain("kind=OPEN");
  });

  it("rejects a status that is not one of the three outcomes", async () => {
    const out = await businessFind.handler({ entity: "deal", status: "pending" }, ctx);
    expect(out.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("business_find — searches", () => {
  it("returns the total alongside the page for customers", async () => {
    // Without the total the model answers "you have 20 customers" whenever the
    // page is full, which is wrong exactly when it matters.
    get.mockResolvedValue(res(true, 200, { companies: [apiCompany], total: 137 }));
    const out = await businessFind.handler({ entity: "customer", query: "roof" }, ctx);
    expect((expectOk(out).data as { total: number }).total).toBe(137);
    expect(get.mock.calls[0][0]).toContain("/api/crm/companies?");
    expect(get.mock.calls[0][0]).toContain("q=roof");
    expect(get.mock.calls[0][0]).toContain("per_page=20");
  });

  it("reports provenance from origin, not from the presence of an external id", async () => {
    // Carried over from crm-handlers.test.ts, which this suite replaces. The
    // two columns can only disagree if something upstream is wrong, and
    // `origin` is the EXPLICIT one — deriving "is this synced?" from
    // `externalSystem != null` is the IS-NULL inference CLAUDE.md bans, and it
    // would report a LOCAL row as synced the moment a reconcile key was
    // written to it without the origin following.
    get.mockResolvedValue(
      res(true, 200, {
        companies: [{ ...apiCompany, origin: "LOCAL", externalSystem: "hubspot" }],
        total: 1,
      }),
    );
    const out = await businessFind.handler({ entity: "customer" }, ctx);
    const customers = (expectOk(out).data as { customers: Array<{ synced_from: string | null }> })
      .customers;
    expect(customers[0]!.synced_from).toBeNull();
  });

  it("carries a deal amount past 2^53 through as an untouched string", async () => {
    // 9007199254740993 minor units. If anything on this path treated it as a
    // number it would come back …992 — off by one, in a figure somebody is
    // about to quote to a customer.
    get.mockResolvedValue(res(true, 200, { deals: [apiDeal], total: 1 }));
    const out = await businessFind.handler({ entity: "deal", status: "WON" }, ctx);
    const deal = (expectOk(out).data as { deals: Array<{ amount_minor: string; outcome: string }> }).deals[0];
    expect(deal.amount_minor).toBe("9007199254740993");
    expect(typeof deal.amount_minor).toBe("string");
    // Outcome comes from stage.kind — the stage NAME is "Closed — signed",
    // which no string match would classify.
    expect(deal.outcome).toBe("WON");
  });

  it("filters deals by outcome, customer and idle days on the request", async () => {
    get.mockResolvedValue(res(true, 200, { deals: [], total: 0 }));
    await businessFind.handler(
      { entity: "deal", status: "OPEN", parent_id: "c1", idle_days: 14 },
      ctx,
    );
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("kind=OPEN");
    expect(url).toContain("company=c1");
    expect(url).toContain("idle_days=14");
    // No query: the page IS the answer, so it is `limit` wide.
    expect(url).toContain("per_page=20");
  });

  it("honours `query` on a deal search instead of dropping it", async () => {
    // HONOURED_ARGS says deal takes `query`, so rejectMisusedArgs let it
    // through -- and the branch never read it, answering ok:true with the
    // unfiltered list. The route has no `q`, so the match is made here over
    // title and customer, as the project branch already does. MUTATION:
    // drop the filter -> d1 comes back for "acme".
    get.mockResolvedValue(
      res(true, 200, {
        deals: [
          { ...apiDeal, id: "d1", title: "Annual contract", companyName: "Example Roofing" },
          { ...apiDeal, id: "d2", title: "Acme rollout", companyName: null },
          { ...apiDeal, id: "d3", title: "Gutters", companyName: "ACME Ltd" },
        ],
        total: 3,
      }),
    );
    const out = await businessFind.handler({ entity: "deal", query: "acme", limit: 1 }, ctx);
    // With a query the request is the route's whole page, not `limit`:
    // filtering twenty rows and calling the survivors "the deals named
    // Acme" is a lie by omission.
    expect(get.mock.calls[0][0]).toContain("per_page=200");
    const data = expectOk(out).data as {
      deals: Array<{ id: string }>;
      total: number;
      note?: string;
    };
    expect(data.deals.map((d) => d.id)).toEqual(["d2"]);
    expect(data.total).toBe(2);
    expect(data.note).toBeUndefined();
  });

  it("says when a deal search could not see the whole table", async () => {
    get.mockResolvedValue(
      res(true, 200, {
        deals: Array.from({ length: 200 }, (_, i) => ({ ...apiDeal, id: `d${i}`, title: `Deal ${i}` })),
        total: 350,
      }),
    );
    const out = await businessFind.handler({ entity: "deal", query: "deal 19" }, ctx);
    const data = expectOk(out).data as { note?: string };
    expect(data.note).toContain("200");
    expect(data.note).toContain("350");
  });

  it("asks the project route for work items when scoped to a project", async () => {
    get.mockResolvedValue(res(true, 200, { work_items: [apiWorkItem] }));
    await businessFind.handler({ entity: "work_item", parent_id: "p1", query: "tiles" }, ctx);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("/api/pm/projects/p1/work-items?");
    expect(url).toContain("q=tiles");
  });

  it("searches work items workspace-wide with no workspace slug", async () => {
    // The whole reason pm_list_workspaces could go: /api/pm/work-items takes
    // an OPTIONAL workspace, so the two-step never had to exist.
    get.mockResolvedValue(res(true, 200, { work_items: [apiWorkItem] }));
    await businessFind.handler({ entity: "work_item", query: "tiles" }, ctx);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("/api/pm/work-items?");
    expect(url).not.toContain("workspace=");
  });

  it("omits description_html from a work-item LIST and keeps it on a single read", async () => {
    // Twenty descriptions is the whole context window.
    get.mockResolvedValue(res(true, 200, { work_items: [apiWorkItem] }));
    const list = await businessFind.handler({ entity: "work_item" }, ctx);
    expect((expectOk(list).data as { work_items: Array<Record<string, unknown>> }).work_items[0]).not.toHaveProperty(
      "description_html",
    );

    vi.clearAllMocks();
    get.mockResolvedValue(res(true, 200, { work_item: apiWorkItem }));
    const one = await businessFind.handler({ entity: "work_item", id: "w1" }, ctx);
    expect((expectOk(one).data as { work_item: Record<string, unknown> }).work_item).toHaveProperty(
      "description_html",
    );
  });
});

describe("business_find — the graph edges", () => {
  it("a customer by id declares all four of the calls it makes", async () => {
    // The completeness gate checks the declared hop LIST. This asserts the
    // handler really does make them.
    get.mockImplementation(async (url: string) => {
      if (url.includes("/api/crm/companies/")) return res(true, 200, { company: apiCompany });
      if (url.includes("/api/crm/deals")) return res(true, 200, { deals: [apiDeal] });
      if (url.includes("/api/crm/contacts")) return res(true, 200, { contacts: [apiContact], total: 1 });
      return res(true, 200, { projects: [apiProject] });
    });
    const out = await businessFind.handler({ entity: "customer", id: "c1" }, ctx);
    expect(out.ok).toBe(true);
    const urls = get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/crm/companies/c1"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/crm/deals?company=c1&kind=OPEN"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/crm/contacts?company=c1"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/pm/projects?"))).toBe(true);

    const data = expectOk(out).data as {
      contacts: Array<{ name: string; title: string | null; phone: string | null }>;
      projects: Array<{ id: string; name: string }>;
    };
    // Role at THIS company beats the person's own job title.
    expect(data.contacts[0].title).toBe("Signatory");
    expect(data.contacts[0].phone).toBe("+15550100");
    expect(data.projects).toEqual([
      { id: "p1", name: "Roof replacement", identifier: "ROOF", workspace: "main" },
    ]);
  });

  it("does NOT reach for projects when no deal became one", async () => {
    // The transitive edge costs one request; it must cost ZERO when there is
    // nothing to resolve. Mutation: drop the `wanted.size > 0` guard → this
    // goes red and every customer read pays for a PM call it cannot use.
    get.mockImplementation(async (url: string) => {
      if (url.includes("/api/crm/companies/")) return res(true, 200, { company: apiCompany });
      if (url.includes("/api/crm/deals"))
        return res(true, 200, { deals: [{ ...apiDeal, projectId: null }] });
      return res(true, 200, { contacts: [], total: 0 });
    });
    await businessFind.handler({ entity: "customer", id: "c1" }, ctx);
    expect(get.mock.calls.some((c) => String(c[0]).includes("/api/pm/projects"))).toBe(false);
  });

  it("resolves a customer's projects in ONE call, not one per deal", async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes("/api/crm/companies/")) return res(true, 200, { company: apiCompany });
      if (url.includes("/api/crm/deals"))
        return res(true, 200, {
          deals: [
            { ...apiDeal, id: "d1", projectId: "p1" },
            { ...apiDeal, id: "d2", projectId: "p2" },
            { ...apiDeal, id: "d3", projectId: "p1" },
          ],
        });
      if (url.includes("/api/crm/contacts")) return res(true, 200, { contacts: [], total: 0 });
      return res(true, 200, { projects: [apiProject, { ...apiProject, id: "p2", name: "Gutters" }] });
    });
    await businessFind.handler({ entity: "customer", id: "c1" }, ctx);
    const pmCalls = get.mock.calls.filter((c) => String(c[0]).includes("/api/pm/projects"));
    expect(pmCalls).toHaveLength(1);
  });

  it("reads by id any linked project the listing did not return", async () => {
    // GET /pm/projects has no `page` and hides archived rows, so one page
    // can miss a project a deal points to -- a box past 200 projects, or a
    // job archived after its deal. Before this the customer came back with
    // `open_deals[].project_id` set and `projects: []`, and the model
    // reported "no delivery project" for one that exists. MUTATION: drop
    // the by-id fallback -> p-far is missing below.
    get.mockImplementation(async (url: string) => {
      if (url.includes("/api/crm/companies/")) return res(true, 200, { company: apiCompany });
      if (url.includes("/api/crm/deals"))
        return res(true, 200, {
          deals: [
            { ...apiDeal, id: "d1", projectId: "p1" },
            { ...apiDeal, id: "d2", projectId: "p-far" },
          ],
        });
      if (url.includes("/api/crm/contacts")) return res(true, 200, { contacts: [], total: 0 });
      if (url === "/api/pm/projects/p-far")
        return res(true, 200, { project: { ...apiProject, id: "p-far", name: "Far away" } });
      return res(true, 200, { projects: [apiProject] });
    });
    const out = await businessFind.handler({ entity: "customer", id: "c1" }, ctx);
    const urls = get.mock.calls.map((c) => c[0] as string);
    // The page is the route's maximum, and only the MISSING id is read.
    expect(urls).toContain("/api/pm/projects?per_page=200");
    expect(urls.filter((u) => /^\/api\/pm\/projects\/[^?]+$/.test(u))).toEqual([
      "/api/pm/projects/p-far",
    ]);
    const projects = (expectOk(out).data as { projects: Array<{ id: string }> }).projects;
    expect(projects.map((p) => p.id).sort()).toEqual(["p-far", "p1"]);
  });

  it("a project by id returns the project and its open work", async () => {
    get.mockImplementation(async (url: string) =>
      url.includes("/work-items")
        ? res(true, 200, { work_items: [apiWorkItem] })
        : res(true, 200, { project: apiProject }),
    );
    const out = await businessFind.handler({ entity: "project", id: "p1" }, ctx);
    const urls = get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/pm/projects/p1"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/pm/projects/p1/work-items"))).toBe(true);
    expect((expectOk(out).data as { work_items: unknown[] }).work_items).toHaveLength(1);
  });
});

describe("business_find — the pipeline entity", () => {
  it("reads the roll-up and reports WHY a stage has no total", async () => {
    // WARP-2556, carried across the move. A fresh stage of unpriced deals used
    // to be reported as mixed currencies, on essentially every new box.
    get.mockResolvedValue(
      res(true, 200, {
        pipelineId: "pl1",
        stages: [
          { stageName: "Qualified", kind: "OPEN", dealCount: 4, valuation: "unpriced", amountMinor: "0", currency: null },
          { stageName: "Proposal", kind: "OPEN", dealCount: 2, valuation: "mixed_currencies", amountMinor: "0", currency: null },
          { stageName: "Won", kind: "WON", dealCount: 1, valuation: "priced", amountMinor: "250000", currency: "USD" },
        ],
      }),
    );
    const out = await businessFind.handler({ entity: "pipeline" }, ctx);
    const stages = (expectOk(out).data as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages[0].total_note).toBe("no amounts entered yet");
    expect(stages[1].total_note).toBe("mixed currencies — not summed");
    expect(stages[2].amount_minor).toBe("250000");
    expect(get.mock.calls[0][0]).toBe("/api/crm/summary");
  });

  it("narrows to one named pipeline with `id`, the same way every entity does", async () => {
    get.mockResolvedValue(res(true, 200, { pipelineId: "pl2", stages: [] }));
    await businessFind.handler({ entity: "pipeline", id: "pl2" }, ctx);
    expect(get.mock.calls[0][0]).toContain("pipeline=pl2");
  });
});

describe("business_timeline", () => {
  it("maps each CRM entity onto its own subject_type", async () => {
    get.mockResolvedValue(res(true, 200, { activities: [] }));
    for (const [entity, subject] of [
      ["customer", "COMPANY"],
      ["contact", "CONTACT"],
      ["deal", "DEAL"],
    ] as const) {
      vi.clearAllMocks();
      await businessTimeline.handler({ entity, id: "x1" }, ctx);
      expect(get.mock.calls[0][0]).toContain(`subject_type=${subject}`);
    }
  });

  it("merges a work item's activity and comments, newest first", async () => {
    get.mockImplementation(async (url: string) =>
      url.endsWith("/activity")
        ? res(true, 200, {
            activity: [
              { id: "a1", verb: "created", field: null, oldValue: null, newValue: null, createdAt: "2026-08-01T00:00:00.000Z" },
              { id: "a2", verb: "changed", field: "state", oldValue: "Todo", newValue: "In Progress", createdAt: "2026-08-03T00:00:00.000Z" },
            ],
          })
        : res(true, 200, {
            comments: [
              { id: "cm1", commentHtml: "<p>Tiles &amp; ridge caps ordered</p>", createdAt: "2026-08-02T00:00:00.000Z" },
            ],
          }),
    );
    const out = await businessTimeline.handler({ entity: "work_item", id: "w1" }, ctx);
    const feed = (expectOk(out).data as { timeline: Array<{ id: string; kind: string; summary: string }> }).timeline;
    expect(feed.map((e) => e.id)).toEqual(["a2", "cm1", "a1"]);
    expect(feed[0].summary).toBe("state: Todo → In Progress");
    // Tags stripped, entities decoded — the model reads a line, not markup.
    expect(feed[1].summary).toBe("Tiles & ridge caps ordered");
  });

  it("does not report a comment twice", async () => {
    // addComment writes BOTH a PmComment and a `verb: "commented"` activity
    // row. Mutation: drop the `verb === "commented"` skip → two entries, one
    // of them empty.
    get.mockImplementation(async (url: string) =>
      url.endsWith("/activity")
        ? res(true, 200, {
            activity: [
              { id: "a9", verb: "commented", field: null, oldValue: null, newValue: null, createdAt: "2026-08-02T00:00:00.000Z" },
            ],
          })
        : res(true, 200, {
            comments: [{ id: "cm1", commentHtml: "<p>Done</p>", createdAt: "2026-08-02T00:00:00.000Z" }],
          }),
    );
    const out = await businessTimeline.handler({ entity: "work_item", id: "w1" }, ctx);
    expect((expectOk(out).data as { timeline: unknown[] }).timeline).toHaveLength(1);
  });

  it("caps the MERGED feed, not each source", async () => {
    get.mockImplementation(async (url: string) =>
      url.endsWith("/activity")
        ? res(true, 200, {
            activity: Array.from({ length: 5 }, (_, i) => ({
              id: `a${i}`,
              verb: "changed",
              field: "state",
              oldValue: "a",
              newValue: "b",
              createdAt: `2026-08-0${i + 1}T00:00:00.000Z`,
            })),
          })
        : res(true, 200, {
            comments: Array.from({ length: 5 }, (_, i) => ({
              id: `c${i}`,
              commentHtml: "<p>x</p>",
              createdAt: `2026-08-1${i}T00:00:00.000Z`,
            })),
          }),
    );
    const out = await businessTimeline.handler({ entity: "work_item", id: "w1", limit: 3 }, ctx);
    expect((expectOk(out).data as { timeline: unknown[] }).timeline).toHaveLength(3);
  });

  it("refuses an entity with no feed rather than inventing a route", async () => {
    const out = await businessTimeline.handler({ entity: "project", id: "p1" }, ctx);
    expect(out.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("a disabled module reads as a switch, not as a missing record", async () => {
    // Both arrive as HTTP 404 and they mean opposite things. Collapsing them
    // has the model tell an owner their customer does not exist because a
    // toggle is off. Mutation: remove the module_disabled branch → the code
    // becomes BUSINESS_NOT_FOUND and the message names nothing actionable.
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "crm" }));
    const out = await businessFind.handler({ entity: "deal" }, ctx);
    expect(out.ok).toBe(false);
    const e = (out as { error: { code: string; message: string } }).error;
    expect(e.code).toBe("BUSINESS_MODULE_OFF");
    expect(e.message).toContain("CRM");
  });

  it("names the Projects module when the PM half is the one switched off", async () => {
    get.mockResolvedValue(res(false, 404, { error: "module_disabled", module: "projects" }));
    const out = await businessFind.handler({ entity: "project" }, ctx);
    expect((out as { error: { message: string } }).error.message).toContain("Projects");
  });

  it("an ordinary 404 stays a not-found so the model can say so", async () => {
    get.mockResolvedValue(res(false, 404, { error: "company_not_found" }));
    const out = await businessFind.handler({ entity: "customer", id: "nope" }, ctx);
    expect((out as { error: { code: string } }).error.code).toBe("BUSINESS_NOT_FOUND");
  });

  it("keeps a 422's message, which names a fixable mistake", async () => {
    get.mockResolvedValue(res(false, 422, { error: "invalid_stage" }));
    const out = await businessFind.handler({ entity: "pipeline" }, ctx);
    const e = (out as { error: { code: string; message: string } }).error;
    expect(e.code).toBe("BUSINESS_INVALID_REQUEST");
    expect(e.message).toBe("invalid_stage");
  });
});
