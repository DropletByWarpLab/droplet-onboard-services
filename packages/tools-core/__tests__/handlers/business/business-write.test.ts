/**
 * ADR-045 slice D — the `business_*` write verbs.
 *
 * Mocks `ctx.http.orchestrator` the way `crm-handlers.test.ts` and
 * `pm-handlers.test.ts` do, and asserts on the CALLS, not just the return
 * values: the whole class of defect this suite exists for is a handler that
 * returns a tidy object having dispatched to the wrong route, the wrong
 * method, or the wrong body shape.
 *
 * The assertions worth having here are the ones no registry or manifest
 * gate can make:
 *   - `patient` is refused, and the refusal does not echo it back;
 *   - a deal's stage move is ONE atomic PATCH, not a PATCH plus a stage POST
 *     (the WARP-2579 partial-write window);
 *   - the box-written timeline kinds stay un-writable now that the check is
 *     runtime rather than a schema enum;
 *   - an unbuilt link edge refuses cleanly, names what it waits for, and
 *     makes NO HTTP call at all;
 *   - no failure result carries `details` — the field a confirmation token
 *     has leaked through before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ToolContext, ToolResult } from "../../../src/types.js";
import businessCreate from "../../../src/handlers/business/create.js";
import businessUpdate from "../../../src/handlers/business/update.js";
import businessLink from "../../../src/handlers/business/link.js";
import {
  LINK_EDGES,
  businessError as writeBusinessError,
} from "../../../src/handlers/business/write-shared.js";
import { businessError as readBusinessError } from "../../../src/handlers/business/_graph.js";

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

function errorOf(r: ToolResult): { code: string; message: string; details?: unknown } {
  if (r.ok) throw new Error("expected a failure result");
  return r.error as { code: string; message: string; details?: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the three verbs are write-tier and confirmation-gated", () => {
  it("declares both flags, and defers the prompt to the interceptor", () => {
    // The WARP-2305 interceptor enforces the flag generically, so the FLAG
    // is the gate — there is no handler-side check to test, and that is
    // what makes this assertion the one that matters. `confirmationOwner`
    // stays unset (= "interceptor") because none of the routes 202s.
    for (const tool of [businessCreate, businessUpdate, businessLink]) {
      expect(tool.requiresWrite, tool.name).toBe(true);
      expect(tool.requiresConfirmation, tool.name).toBe(true);
      expect(tool.confirmationOwner, tool.name).toBeUndefined();
    }
  });
});

describe("business_create", () => {
  it("creates a customer and hands back the id the next call needs", async () => {
    post.mockResolvedValueOnce(res(true, 201, { company: { id: "c1", name: "Example Roofing" } }));
    const out = await businessCreate.handler({ entity: "customer", name: "  Example Roofing " }, ctx);
    expect(post).toHaveBeenCalledWith("/api/crm/companies", { name: "Example Roofing" }, expect.anything());
    expect(out.ok).toBe(true);
    expect((out as { data: { created: { id: string } } }).data.created.id).toBe("c1");
  });

  it("creates a task under the project named by parent_id", async () => {
    post.mockResolvedValueOnce(res(true, 201, { work_item: { id: "w1", name: "Fix the flashing" } }));
    await businessCreate.handler(
      { entity: "task", name: "Fix the flashing", parent_entity: "project", parent_id: "p 1" },
      ctx,
    );
    // The id is URL-encoded, not interpolated raw.
    expect(post.mock.calls[0][0]).toBe("/api/pm/projects/p%201/work-items");
  });

  it("routes a note by its PARENT: a task note is a comment, a deal note is a timeline entry", async () => {
    post.mockResolvedValueOnce(res(true, 201, { comment: { id: "cm1" } }));
    await businessCreate.handler(
      { entity: "note", name: "Chased the supplier", parent_entity: "task", parent_id: "w1" },
      ctx,
    );
    expect(post.mock.calls[0][0]).toBe("/api/pm/work-items/w1/comments");
    expect(post.mock.calls[0][1]).toEqual({ comment_html: "Chased the supplier" });

    vi.clearAllMocks();
    post.mockResolvedValueOnce(res(true, 201, { activity: { id: "a1" } }));
    await businessCreate.handler(
      { entity: "note", name: "Called them", parent_entity: "deal", parent_id: "d1", note_kind: "call" },
      ctx,
    );
    expect(post.mock.calls[0][0]).toBe("/api/crm/activities");
    // The subject lands on the MATCHING column only — the other is null, not
    // absent, because the route's CHECK constraint is what enforces
    // exactly-one-of and it reads columns, not undefined.
    expect(post.mock.calls[0][1]).toMatchObject({
      subjectType: "DEAL",
      dealId: "d1",
      companyId: null,
      kind: "CALL",
    });
  });

  it("cannot write the box-written timeline kinds", async () => {
    // `crm_log_activity` blocked STAGE_CHANGE / CREATED / SYNCED with a
    // schema enum. That enum is gone (the schema spends its enum budget on
    // `entity`), so this is the assertion that keeps the guarantee: a
    // model-written stage change with no move behind it would make the
    // timeline lie about the pipeline.
    for (const kind of ["stage_change", "created", "synced"]) {
      const out = await businessCreate.handler(
        { entity: "note", name: "x", parent_entity: "deal", parent_id: "d1", note_kind: kind },
        ctx,
      );
      expect(errorOf(out).code, kind).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("bounds the name at the ROUTE's limit for each entity, not at one shared number", async () => {
    // A generic 500-char gate used to run before the note branch's own
    // 1000-char check, which made that check dead and refused a 501-char
    // note the orchestrator (`activityCreateSchema.summary`, max 1000)
    // would have accepted -- with a message naming the wrong bound.
    // MUTATION: restore one `title.length > 500` gate -> the 1000-char note
    // below is refused.
    post.mockImplementation(async () =>
      res(true, 201, {
        company: { id: "c1", name: "x" },
        deal: { id: "d1", title: "x" },
        project: { id: "p1", name: "x" },
        work_item: { id: "w1", name: "x" },
        activity: { id: "a1" },
      }),
    );
    const note = (n: number) => ({
      entity: "note",
      name: "n".repeat(n),
      parent_entity: "deal",
      parent_id: "d1",
    });
    expect((await businessCreate.handler(note(1000), ctx)).ok).toBe(true);
    expect(errorOf(await businessCreate.handler(note(1001), ctx)).message).toContain("1000");

    // companyCreateSchema.name 300, dealCreateSchema.title 300,
    // projectCreateSchema.name 200, workItemCreateSchema.name 500.
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ entity: "customer", name: "c".repeat(301) }, 300],
      [{ entity: "deal", name: "d".repeat(301) }, 300],
      [{ entity: "project", name: "p".repeat(201) }, 200],
      [{ entity: "task", name: "t".repeat(501), parent_id: "p1" }, 500],
    ];
    for (const [args, max] of cases) {
      const err = errorOf(await businessCreate.handler(args, ctx));
      expect(err.code, String(args.entity)).toBe("INVALID_ARGS");
      expect(err.message, String(args.entity)).toContain(String(max));
    }
    // ...and each bound is its own: a 300-char TASK name is fine.
    expect(
      (await businessCreate.handler({ entity: "task", name: "t".repeat(300), parent_id: "p1" }, ctx)).ok,
    ).toBe(true);
  });

  it("creates a deal with no customer, or under a trimmed customer id", async () => {
    post.mockResolvedValue(res(true, 201, { deal: { id: "d1", title: "Trade show enquiry" } }));
    await businessCreate.handler({ entity: "deal", name: "Trade show enquiry" }, ctx);
    expect(post.mock.calls[0][1]).toEqual({ title: "Trade show enquiry", companyId: undefined });

    vi.clearAllMocks();
    post.mockResolvedValue(res(true, 201, { deal: { id: "d2", title: "Annual" } }));
    await businessCreate.handler(
      { entity: "deal", name: "Annual", parent_entity: "customer", parent_id: " c1 " },
      ctx,
    );
    expect(post.mock.calls[0][1]).toEqual({ title: "Annual", companyId: "c1" });
  });

  it("refuses an empty parent_id on a deal instead of writing an empty companyId", async () => {
    // `createDeal` skips the company-exists check on a falsy companyId and
    // then writes the literal empty string (`input.companyId ?? null` --
    // "" is not null): neither a customer nor the absent state. MUTATION:
    // go back to `typeof parent_id === "string"` -> "" is forwarded and
    // this dispatches.
    for (const parent_id of ["", "   "]) {
      const out = await businessCreate.handler(
        { entity: "deal", name: "x", parent_entity: "customer", parent_id },
        ctx,
      );
      expect(errorOf(out).code, JSON.stringify(parent_id)).toBe("INVALID_ARGS");
    }
    // A parent_id with no parent_entity names the only parent a deal can
    // have, so an EMPTY one is still an error and not "no customer".
    expect(
      errorOf(await businessCreate.handler({ entity: "deal", name: "x", parent_id: " " }, ctx)).code,
    ).toBe("INVALID_ARGS");
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a deal parent that is not a customer, as the task branch refuses a non-project", async () => {
    // A mismatched parent_entity used to be treated as "no parent": the deal
    // was created unlinked with ok:true and nothing said the argument meant
    // nothing. MUTATION: drop the parent_entity check -> this dispatches.
    const out = await businessCreate.handler(
      { entity: "deal", name: "x", parent_entity: "project", parent_id: "p1" },
      ctx,
    );
    expect(errorOf(out).code).toBe("INVALID_ARGS");
    expect(errorOf(out).message).toContain("customer");
    expect(post).not.toHaveBeenCalled();
  });

  it("carries a description to a task as description_html and to a project as description", async () => {
    post.mockResolvedValue(res(true, 201, { work_item: { id: "w1", name: "x" } }));
    await businessCreate.handler(
      {
        entity: "task",
        name: "Fix the flashing",
        parent_id: "p1",
        description: "North ridge, lead is lifting.",
      },
      ctx,
    );
    expect(post.mock.calls[0][1]).toEqual({
      name: "Fix the flashing",
      description_html: "North ridge, lead is lifting.",
    });

    vi.clearAllMocks();
    post.mockResolvedValue(res(true, 201, { project: { id: "p1", name: "x" } }));
    await businessCreate.handler(
      { entity: "project", name: "Roof", description: "From the surveyor's report", identifier: "ROOF" },
      ctx,
    );
    expect(post.mock.calls[0][1]).toEqual({
      name: "Roof",
      description: "From the surveyor's report",
      identifier: "ROOF",
    });
  });

  it("validates identifier and description like the routes, before any call", async () => {
    // projectCreateSchema: identifier /^[A-Za-z0-9]+$/ of 1-10, description
    // max 10000; workItemCreateSchema: description_html max 100000. Mirrored
    // so a malformed value comes back as a message the model can act on
    // rather than an opaque 400 from zod -- the deleted pm_create_project
    // ran the same checks.
    const refused: Array<Record<string, unknown>> = [
      { entity: "project", name: "ok", identifier: "TOO-LONG-AND-HYPHENATED" },
      { entity: "project", name: "ok", identifier: "has space" },
      { entity: "project", name: "ok", identifier: "" },
      { entity: "project", name: "ok", identifier: "ABCDEFGHIJK" },
      { entity: "project", name: "ok", description: "d".repeat(10001) },
      { entity: "task", name: "ok", parent_id: "p1", description: "d".repeat(100001) },
    ];
    for (const args of refused) {
      expect(
        errorOf(await businessCreate.handler(args, ctx)).code,
        JSON.stringify(args).slice(0, 60),
      ).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();

    post.mockResolvedValue(res(true, 201, { project: { id: "p1", name: "ok" } }));
    expect(
      (await businessCreate.handler({ entity: "project", name: "ok", identifier: "ABCDE12345" }, ctx)).ok,
    ).toBe(true);
  });

  it("refuses description and identifier on an entity that has no such field", async () => {
    // Never silently dropped -- the same rule as `note_kind` on a task.
    for (const args of [
      { entity: "customer", name: "x", description: "y" },
      { entity: "note", name: "x", parent_entity: "deal", parent_id: "d1", description: "y" },
      { entity: "task", name: "x", parent_id: "p1", identifier: "TASK" },
      { entity: "deal", name: "x", identifier: "DEAL" },
    ]) {
      expect(errorOf(await businessCreate.handler(args, ctx)).code, String(args.entity)).toBe(
        "INVALID_ARGS",
      );
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses `patient` without echoing it, and without dispatching", async () => {
    // ADR-044, non-negotiable. The refusal names only the entities that
    // exist: echoing the rejected value back would be the natural thing to
    // write and would acknowledge the one word this surface must not.
    const out = await businessCreate.handler({ entity: "patient", name: "anyone" }, ctx);
    const err = errorOf(out);
    expect(err.code).toBe("INVALID_ARGS");
    expect(err.message).not.toContain("patient");
    expect(err.message).toContain("customer");
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps `patient` out of the schema's own enum", () => {
    const entity = (businessCreate.inputSchema as {
      properties: { entity: { enum: string[] } };
    }).properties.entity.enum;
    expect(entity).toEqual(["customer", "deal", "project", "task", "note"]);
  });
});

describe("business_update", () => {
  it("moves a deal's stage in ONE patch, never a patch plus a stage post", async () => {
    // WARP-2579 made `PATCH /crm/deals/:id` apply the move inside the same
    // transaction as the field update, STAGE_CHANGE timeline row included.
    // Splitting it back into two calls would re-open the exact window that
    // ticket closed: a field update that throws after the board has already
    // changed. MUTATION: dispatch the stage move separately → red here.
    patch.mockResolvedValueOnce(
      res(true, 200, {
        deal: { id: "d1", title: "Annual contract", stage: { name: "Negotiation", kind: "OPEN" } },
      }),
    );
    const out = await businessUpdate.handler(
      { entity: "deal", id: "d1", state: "s2", name: "Annual contract", assignee: "u9" },
      ctx,
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(patch.mock.calls[0][0]).toBe("/api/crm/deals/d1");
    expect(patch.mock.calls[0][1]).toEqual({
      title: "Annual contract",
      stageId: "s2",
      ownerId: "u9",
    });
    // The OUTCOME comes from stage.kind — the stage NAME here is
    // "Negotiation", which no string match would classify.
    expect((out as { data: { updated: { outcome: string } } }).data.updated.outcome).toBe("OPEN");
  });

  it("transitions a task through the same patch, and sets the assignee as a list", async () => {
    // The route answers with the full ApiWorkItem: `state` is an ApiState
    // OBJECT, not a name. What reaches the model is the NAME, flattened the
    // way the read path's `toPlaneWorkItem` already does it. MUTATION: hand
    // `data.work_item.state` back raw -> the model reads `{id, projectId, ...}`.
    patch.mockResolvedValueOnce(
      res(true, 200, {
        work_item: {
          id: "w1",
          name: "Fix it",
          descriptionHtml: null,
          stateId: "st_done",
          state: {
            id: "st_done",
            projectId: "p1",
            name: "Done",
            group: "completed",
            color: null,
            sortOrder: 4,
            isDefault: false,
          },
          assignees: ["u3"],
          labels: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    );
    const out = await businessUpdate.handler(
      { entity: "task", id: "w1", state: "st_done", assignee: "u3" },
      ctx,
    );
    expect(patch.mock.calls[0][0]).toBe("/api/pm/work-items/w1");
    expect(patch.mock.calls[0][1]).toEqual({
      name: undefined,
      state_id: "st_done",
      assignees: ["u3"],
    });
    const updated = (out as { data: { updated: { state: unknown } } }).data.updated;
    expect(updated.state).toBe("Done");
  });

  it("carries a description to a task as description_html, and refuses it elsewhere", async () => {
    // The deleted pm_update_work_item could rewrite a task's body; the first
    // cut of this verb dropped that with no note (#2005 review, finding 5).
    // Same route field and bound as create.ts. MUTATION: drop
    // `description_html` from the PATCH body -> the first assertion goes red.
    patch.mockResolvedValueOnce(
      res(true, 200, {
        work_item: {
          id: "w1",
          name: "Fix it",
          descriptionHtml: "<p>Ridge tiles, 40 boxes.</p>",
          stateId: null,
          state: null,
          assignees: [],
          labels: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    );
    const out = await businessUpdate.handler(
      { entity: "task", id: "w1", description: "<p>Ridge tiles, 40 boxes.</p>" },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(patch.mock.calls[0][0]).toBe("/api/pm/work-items/w1");
    expect(patch.mock.calls[0][1]).toMatchObject({
      description_html: "<p>Ridge tiles, 40 boxes.</p>",
    });
    // `labels` stays out on purpose, on BOTH verbs, until a tool can read a
    // project's labels - the header says why. Pinned so it cannot creep back
    // on one verb and not the other.
    expect(Object.keys(patch.mock.calls[0][1])).not.toContain("label_ids");
    expect(Object.keys(patch.mock.calls[0][1])).not.toContain("labels");

    // A deal's free text is a note (a timeline entry), not a field.
    const deal = await businessUpdate.handler({ entity: "deal", id: "d1", description: "x" }, ctx);
    expect(errorOf(deal).code).toBe("INVALID_ARGS");
    expect(errorOf(deal).message).toContain("description");
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("refuses a no-op patch rather than spending an approval on nothing", async () => {
    const out = await businessUpdate.handler({ entity: "deal", id: "d1" }, ctx);
    expect(errorOf(out).code).toBe("INVALID_ARGS");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses a state on a customer, and refuses `project` outright", async () => {
    const state = await businessUpdate.handler({ entity: "customer", id: "c1", state: "x" }, ctx);
    expect(errorOf(state).code).toBe("INVALID_ARGS");
    // `project` is absent because PATCH /pm/projects/:id does not admit the
    // mcp principal — a branch here would ship registered and 403ing.
    const project = await businessUpdate.handler({ entity: "project", id: "p1", name: "x" }, ctx);
    expect(errorOf(project).message).not.toContain("project");
    expect(patch).not.toHaveBeenCalled();
  });

  it("maps a 404 to NOT_FOUND and keeps a 422's message verbatim", async () => {
    patch.mockResolvedValueOnce(res(false, 404, { error: "deal_not_found" }));
    expect(errorOf(await businessUpdate.handler({ entity: "deal", id: "nope", state: "s" }, ctx)).code).toBe(
      "BUSINESS_NOT_FOUND",
    );
    // A stage from another pipeline is a fixable mistake the model can act
    // on; flattening it into the same code as "no such deal" makes it
    // unrecoverable.
    patch.mockResolvedValueOnce(res(false, 422, { error: "invalid_stage" }));
    const wrong = errorOf(await businessUpdate.handler({ entity: "deal", id: "d1", state: "sX" }, ctx));
    expect(wrong.code).toBe("BUSINESS_INVALID_REQUEST");
    expect(wrong.message).toBe("invalid_stage");
  });
});

describe("business_link degrades", () => {
  it("writes the two edges that exist on this box", async () => {
    patch.mockResolvedValueOnce(res(true, 200, { deal: { id: "d1", title: "Annual", company: null } }));
    await businessLink.handler(
      { from_entity: "deal", from_id: "d1", to_entity: "project", to_id: "p1", kind: "delivers" },
      ctx,
    );
    expect(patch.mock.calls[0][0]).toBe("/api/crm/deals/d1");
    expect(patch.mock.calls[0][1]).toEqual({ projectId: "p1" });

    vi.clearAllMocks();
    patch.mockResolvedValueOnce(res(true, 200, { deal: { id: "d1", title: "Annual", company: "Acme" } }));
    await businessLink.handler(
      { from_entity: "deal", from_id: "d1", to_entity: "customer", to_id: "c1", kind: "belongs_to" },
      ctx,
    );
    expect(patch.mock.calls[0][1]).toEqual({ companyId: "c1" });
  });

  it("refuses every not_built edge without dispatching, and says what it waits for", async () => {
    // The degradation contract, driven from the table rather than from a
    // copied list — a tenth unbuilt edge is covered the day it is added.
    for (const edge of LINK_EDGES.filter((e) => e.status === "not_built")) {
      const out = await businessLink.handler(
        { from_entity: edge.from, from_id: "a", to_entity: edge.to, to_id: "b", kind: edge.kind },
        ctx,
      );
      const err = errorOf(out);
      expect(err.code, `${edge.from}->${edge.to}`).toBe("BUSINESS_LINK_NOT_AVAILABLE");
      expect(err.message).toContain(edge.blockedBy!);
      // ...and it still tells the caller what DOES work, so a refusal is one
      // more turn rather than a dead end.
      expect(err.message).toContain("deal -> project (delivers)");
    }
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("separates an unknown edge from an unbuilt one", async () => {
    // Two different codes on purpose: "that does not exist" and "that does
    // not exist YET" are different answers, and only the second should send
    // anyone looking for the ticket.
    const out = await businessLink.handler(
      { from_entity: "customer", from_id: "c1", to_entity: "invoice", to_id: "i1", kind: "paid_by" },
      ctx,
    );
    expect(errorOf(out).code).toBe("BUSINESS_LINK_UNKNOWN");
    expect(patch).not.toHaveBeenCalled();
  });

  it("has exactly the two live edges, and both are on the deal", () => {
    // Non-vacuity for the degradation test above, and the assertion that
    // goes red the moment a slice flips a row to `live` without wiring a
    // dispatch branch for it.
    const live = LINK_EDGES.filter((e) => e.status === "live");
    expect(live.map((e) => `${e.from}->${e.to}`)).toEqual(["deal->project", "deal->customer"]);
  });
});

describe("a disabled module reads as a switch on the write path too", () => {
  it("maps module_disabled to BUSINESS_MODULE_OFF on create, update and link", async () => {
    // The read path had this mapping and the write path did not, so with
    // the CRM off `business_create` answered BUSINESS_NOT_FOUND
    // "module_disabled" -- and a model reading that tells the owner the
    // record does not exist. MUTATION: give write-shared its own mapper
    // without the branch -> NOT_FOUND here.
    post.mockResolvedValueOnce(res(false, 404, { error: "module_disabled", module: "projects" }));
    const c = errorOf(await businessCreate.handler({ entity: "project", name: "Roof" }, ctx));
    expect(c.code).toBe("BUSINESS_MODULE_OFF");
    expect(c.message).toContain("Projects");

    patch.mockResolvedValueOnce(res(false, 404, { error: "module_disabled", module: "crm" }));
    const u = errorOf(await businessUpdate.handler({ entity: "deal", id: "d1", state: "s2" }, ctx));
    expect(u.code).toBe("BUSINESS_MODULE_OFF");
    expect(u.message).toContain("CRM");

    patch.mockResolvedValueOnce(res(false, 404, { error: "module_disabled", module: "crm" }));
    const l = errorOf(
      await businessLink.handler(
        { from_entity: "deal", from_id: "d1", to_entity: "project", to_id: "p1", kind: "delivers" },
        ctx,
      ),
    );
    expect(l.code).toBe("BUSINESS_MODULE_OFF");
    expect(l.message).toContain("CRM");
  });

  it("is ONE mapper, shared with the read path", () => {
    // Two copies of the same function is how the write path lost the branch
    // in the first place.
    expect(writeBusinessError).toBe(readBusinessError);
  });
});

describe("no business_* failure can carry a confirmation token", () => {
  it("has no `details` field on any error result", async () => {
    // A confirmation token has reached the model through `error.details`
    // before. These handlers cannot repeat it, because their failure shape
    // has no field to repeat it in — the same argument
    // `InterceptorAuditEvent` makes about PHI. MUTATION: add a `details`
    // block to `businessError` → red.
    patch.mockResolvedValue(res(false, 500, { error: "boom" }));
    post.mockResolvedValue(res(false, 500, { error: "boom" }));
    const failures = [
      await businessCreate.handler({ entity: "customer", name: "x" }, ctx),
      await businessCreate.handler({ entity: "patient", name: "x" }, ctx),
      await businessUpdate.handler({ entity: "deal", id: "d1", state: "s" }, ctx),
      await businessLink.handler(
        { from_entity: "task", from_id: "a", to_entity: "task", to_id: "b", kind: "blocks" },
        ctx,
      ),
    ];
    for (const r of failures) {
      expect(r.ok).toBe(false);
      expect(errorOf(r).details).toBeUndefined();
    }
  });
});
