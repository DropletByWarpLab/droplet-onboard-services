/**
 * WARP-3537 — the HTTP face of the bulk edit: who may call it, what body it
 * accepts, and what it says when the service refuses. What the transaction DOES
 * is `__tests__/pm-bulk.pg.test.ts`'s claim — here the service is a stub, so these
 * tests are about what the route lets through and how a refusal reaches the caller.
 *
 * The guest refusal is not asserted here. It is the `projects` module's tier
 * floor, and `__tests__/guest-company-data.test.ts` probes this router's route
 * through the real mount.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const svc = vi.hoisted(() => ({ bulkUpdateWorkItems: vi.fn() }));
vi.mock("../../services/pm/pm-bulk.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-bulk.service.js")>();
  return { ...actual, bulkUpdateWorkItems: svc.bulkUpdateWorkItems };
});

import { PM_BULK_ERRORS, PmBulkError } from "../../services/pm/pm-bulk.service.js";
import { PM_ERRORS, PmRefError } from "../../services/pm/pm.service.js";
import { createPmBulkRouter } from "./bulk.js";

const OWNER = { id: "u-owner", role: "owner" };
const FAMILY = { id: "u-fam", role: "family" };

function makeApp(user: { id: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { ...user, username: user.id, displayName: user.id, role: user.role as AuthUser["role"] } as AuthUser;
    next();
  });
  app.use("/api", createPmBulkRouter({} as never));
  // The app's error handler shape, just enough to see a 500.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal", message: err.message });
  });
  return app;
}

const RESULT = { changed: 2, work_items: [] };
const post = (body: unknown, user = FAMILY) => request(makeApp(user)).post("/api/pm/work-items/bulk").send(body as object);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);

beforeEach(() => {
  svc.bulkUpdateWorkItems.mockReset().mockResolvedValue(RESULT);
});

describe("POST /api/pm/work-items/bulk: the happy path", () => {
  it("hands the ids, the patch and the caller to the service, and returns what it returns", async () => {
    const patch = {
      stateId: "s1",
      priority: "high",
      assigneeIds: ["u1"],
      addLabelIds: ["l1"],
      removeLabelIds: ["l2"],
      cycleId: null,
      isArchived: false,
    };
    const res = await post({ ids: ["a", "b"], patch });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESULT);
    expect(svc.bulkUpdateWorkItems).toHaveBeenCalledTimes(1);
    const [, actor, input] = svc.bulkUpdateWorkItems.mock.calls[0];
    expect(actor).toEqual({ userId: "u-fam", role: "family" });
    expect(input).toEqual({ ids: ["a", "b"], patch });
  });

  it("accepts exactly 500 ids", async () => {
    expect((await post({ ids: ids(500), patch: { priority: "low" } })).status).toBe(200);
  });

  it.each([
    ["cycleId null (take it out of its cycle)", { cycleId: null }],
    ["isArchived false (restore)", { isArchived: false }],
    ["assigneeIds [] (clear everyone)", { assigneeIds: [] }],
  ])("a patch that says %s is a patch, though every value in it is falsy", async (_name, patch) => {
    expect((await post({ ids: ["a"], patch })).status).toBe(200);
  });
});

describe("POST /api/pm/work-items/bulk: who may call it", () => {
  it.each([["owner", OWNER], ["admin", { id: "u-adm", role: "admin" }], ["family", FAMILY]])(
    "lets a %s",
    async (_name, user) => {
      expect((await post({ ids: ["a"], patch: { priority: "low" } }, user)).status).toBe(200);
    },
  );

  it.each(["member", "viewer", "guest", "service"])("refuses a %s with a 403 and never runs the service", async (role) => {
    const res = await post({ ids: ["a"], patch: { priority: "low" } }, { id: "u-x", role });
    expect(res.status).toBe(403);
    expect(svc.bulkUpdateWorkItems).not.toHaveBeenCalled();
  });

  it("does not admit the assistant's service principal — it has no person to attribute a change to, and no bulk tool exists", async () => {
    const res = await post({ ids: ["a"], patch: { priority: "low" } }, { id: "_service:mcp", role: "service" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/pm/work-items/bulk: validation (400 invalid_request)", () => {
  const bad = async (body: unknown) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(svc.bulkUpdateWorkItems).not.toHaveBeenCalled();
    return res;
  };

  it("needs a body with ids and a patch", async () => {
    await bad({});
    await bad({ ids: ["a"] });
    await bad({ patch: { priority: "low" } });
  });

  it("needs at least one id and at most 500", async () => {
    await bad({ ids: [], patch: { priority: "low" } });
    await bad({ ids: ids(501), patch: { priority: "low" } });
  });

  it("refuses an id that is not a short string", async () => {
    await bad({ ids: [""], patch: { priority: "low" } });
    await bad({ ids: [7], patch: { priority: "low" } });
    await bad({ ids: ["x".repeat(65)], patch: { priority: "low" } });
  });

  it("needs a patch that says something", async () => {
    await bad({ ids: ["a"], patch: {} });
  });

  it.each(["moduleId", "type", "estimate", "title", "name", "labelIds", "unknown"])(
    "refuses the key %s — a field this slice does not own is an error, not silently ignored",
    async (key) => {
      const res = await bad({ ids: ["a"], patch: { priority: "low", [key]: "x" } });
      expect(JSON.stringify(res.body.details)).toContain(key);
    },
  );

  it("refuses an unknown top-level key", async () => {
    await bad({ ids: ["a"], patch: { priority: "low" }, extra: true });
  });

  it("refuses a state to clear, a priority that is not one, a non-boolean archive flag", async () => {
    await bad({ ids: ["a"], patch: { stateId: null } });
    await bad({ ids: ["a"], patch: { stateId: "" } });
    await bad({ ids: ["a"], patch: { priority: "critical" } });
    await bad({ ids: ["a"], patch: { isArchived: "yes" } });
  });

  it("refuses a list past 50 entries", async () => {
    await bad({ ids: ["a"], patch: { assigneeIds: ids(51) } });
    await bad({ ids: ["a"], patch: { addLabelIds: ids(51) } });
  });

  it("refuses a label that is both added and removed", async () => {
    await bad({ ids: ["a"], patch: { addLabelIds: ["l1", "l2"], removeLabelIds: ["l2"] } });
  });
});

describe("POST /api/pm/work-items/bulk: what a refusal looks like", () => {
  const refuse = (code: string, itemIds: string[] = []) =>
    svc.bulkUpdateWorkItems.mockRejectedValue(new PmBulkError(code, itemIds));
  const body = { ids: ["a", "b", "c"], patch: { priority: "low" } };

  it("403 work_items_forbidden lists the forbidden ids", async () => {
    refuse(PM_BULK_ERRORS.FORBIDDEN, ["b", "c"]);
    const res = await post(body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "work_items_forbidden", ids: ["b", "c"] });
  });

  it("404 work_item_not_found lists the ids that are not work items", async () => {
    refuse(PM_ERRORS.WORK_ITEM_NOT_FOUND, ["c"]);
    const res = await post(body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "work_item_not_found", ids: ["c"] });
  });

  it.each([
    [PM_ERRORS.STATE_NOT_FOUND, 404],
    [PM_ERRORS.LABEL_NOT_FOUND, 404],
    [PM_BULK_ERRORS.CYCLE_NOT_FOUND, 404],
  ])("%s is %i", async (code, status) => {
    refuse(code);
    const res = await post(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it.each([
    [PM_ERRORS.INVALID_STATE],
    [PM_BULK_ERRORS.INVALID_LABEL],
    [PM_BULK_ERRORS.INVALID_CYCLE],
  ])("422 %s lists the items it does not fit", async (code) => {
    refuse(code, ["a", "c"]);
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: code, ids: ["a", "c"] });
  });

  it("409 concurrent_mutation says nothing was applied", async () => {
    svc.bulkUpdateWorkItems.mockRejectedValue(new Error(PM_ERRORS.CONCURRENT_MUTATION));
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "concurrent_mutation", code: "CONCURRENT_MUTATION" });
    expect(res.body.message).toMatch(/Nothing was applied/);
  });

  it("422 invalid_assignee names the unusable people in the patch", async () => {
    svc.bulkUpdateWorkItems.mockRejectedValue(new PmRefError(PM_ERRORS.INVALID_ASSIGNEE, ["leaver", "missing"]));
    const res = await post({ ids: ["a", "b"], patch: { assigneeIds: ["leaver", "missing"] } });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_assignee", ids: ["leaver", "missing"] });
  });

  it("anything else is the error handler's, not a leaked code", async () => {
    svc.bulkUpdateWorkItems.mockRejectedValue(new Error("boom"));
    const res = await post(body);
    expect(res.status).toBe(500);
  });
});
