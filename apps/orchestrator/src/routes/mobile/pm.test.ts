/**
 * WARP-3371 — the mobile work-items list gained a cursor, and the one promise
 * that matters is that nothing about it moved for a client that has never heard
 * of it: no `limit`, no `per_page`, no `cursor` is still a page of 50, and the
 * `work_items` rows are exactly the contract's envelope. `next_cursor` and
 * `total` are additive.
 *
 * The service is stubbed: this file pins what the ROUTE hands it and what it
 * answers (the keyset itself is proved in `pm-list-paging.pg.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const listWorkItems = vi.fn();

vi.mock("../../services/pm/pm.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/pm/pm.service.js")>()),
  listWorkItems: (...args: unknown[]) => listWorkItems(...args),
}));

import { createPmMobileRouter } from "./pm.js";

function makeApp(role = "family") {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: AuthUser }).user = {
      id: "u1",
      username: "u1",
      displayName: "u1",
      role: role as AuthUser["role"],
    };
    next();
  });
  app.use(createPmMobileRouter({} as never));
  return app;
}

const ITEM = {
  id: "wi-1",
  projectId: "p1",
  name: "First",
  state: { name: "Todo" },
  assignees: ["u2"],
  labels: [{ name: "bug" }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const URL = "/api/mobile/pm/work-items?workspace=home&project_id=p1";

beforeEach(() => {
  listWorkItems.mockReset();
  listWorkItems.mockResolvedValue({ items: [ITEM], nextCursor: null, total: 1 });
});

describe("GET /api/mobile/pm/work-items — backward compatible paging (WARP-3371)", () => {
  it("a client that sends no limit, per_page or cursor gets a page of 50 — the pre-cursor default", async () => {
    const res = await request(makeApp()).get(URL);
    expect(res.status).toBe(200);
    expect(listWorkItems.mock.calls[0][2]).toMatchObject({ limit: 50, cursor: undefined });
  });

  it("the envelope rows are unchanged and the two new fields are additive", async () => {
    const res = await request(makeApp()).get(URL);
    expect(res.body).toEqual({
      work_items: [
        {
          id: "wi-1",
          name: "First",
          state: "Todo",
          assignees: ["u2"],
          labels: ["bug"],
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-02T00:00:00.000Z",
        },
      ],
      next_cursor: null,
      total: 1,
    });
  });

  it("`per_page` still sets the page size, `limit` is the new name and wins, and both cap at 100", async () => {
    await request(makeApp()).get(`${URL}&per_page=20`);
    expect(listWorkItems.mock.calls[0][2].limit).toBe(20);
    await request(makeApp()).get(`${URL}&limit=30&per_page=20`);
    expect(listWorkItems.mock.calls[1][2].limit).toBe(30);
    await request(makeApp()).get(`${URL}&limit=500`);
    expect(listWorkItems.mock.calls[2][2].limit).toBe(100);
    await request(makeApp()).get(`${URL}&per_page=0`);
    expect(listWorkItems.mock.calls[3][2].limit).toBe(1);
  });

  it("a garbage page size still falls back to 50 instead of becoming a 400 (clients written against the old route)", async () => {
    const res = await request(makeApp()).get(`${URL}&per_page=abc`);
    expect(res.status).toBe(200);
    expect(listWorkItems.mock.calls[0][2].limit).toBe(50);
  });

  it("hands the cursor through and returns `next_cursor` + `total` for a client that reads them", async () => {
    listWorkItems.mockResolvedValue({ items: [ITEM], nextCursor: "opaque-next", total: 250 });
    const res = await request(makeApp()).get(`${URL}&cursor=opaque-prev`);
    expect(listWorkItems.mock.calls[0][2].cursor).toBe("opaque-prev");
    expect(res.body.next_cursor).toBe("opaque-next");
    expect(res.body.total).toBe(250);
  });

  it("a cursor the service refuses is 400 PM_INVALID_CURSOR", async () => {
    listWorkItems.mockRejectedValue(new Error("invalid_cursor"));
    const res = await request(makeApp()).get(`${URL}&cursor=garbage`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid cursor", code: "PM_INVALID_CURSOR" });
  });

  it("a malformed cursor parameter (empty, repeated) is a 400 before the service is touched", async () => {
    const empty = await request(makeApp()).get(`${URL}&cursor=`);
    expect(empty.status).toBe(400);
    const twice = await request(makeApp()).get(`${URL}&cursor=a&cursor=b`);
    expect(twice.status).toBe(400);
    expect(listWorkItems).not.toHaveBeenCalled();
  });

  it("the role floor is unchanged: guests are refused, the service principal too", async () => {
    expect((await request(makeApp("guest")).get(URL)).status).toBe(403);
    expect((await request(makeApp("service")).get(URL)).status).toBe(403);
    expect(listWorkItems).not.toHaveBeenCalled();
  });
});
