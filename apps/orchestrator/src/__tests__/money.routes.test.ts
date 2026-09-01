/**
 * WARP-2581 — `/api/money`, at the route.
 *
 * The service tests own the arithmetic. What is pinned here is the boundary:
 * who may ask, what the query words mean, and that the response carries no
 * cross-ledger total for a caller to reach for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createMoneyRouter } from "../routes/money.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function dec(value: string) {
  return { toString: () => value, isZero: () => Number.parseFloat(value) === 0 };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    kind: "RECEIVABLE",
    externalId: "INV-1001",
    externalSystem: "quickbooks-online",
    connectionId: "conn-1",
    issuedAt: new Date("2026-08-01T00:00:00Z"),
    dueAt: new Date("2026-08-15T00:00:00Z"),
    counterpartyExternalId: "cust-7",
    counterpartyName: "Northgate Dental",
    companyId: null,
    amount: dec("4210.55"),
    balance: dec("1200.00"),
    currency: null,
    status: "Open",
    vendorUpdatedAt: null,
    lastReadAt: new Date("2026-09-01T11:30:00Z"),
    ...over,
  };
}

let rows: ReturnType<typeof row>[];
let findMany: ReturnType<typeof vi.fn>;

function app(role: "owner" | "admin" | "family" | "guest" | null = "owner") {
  findMany = vi.fn(async (args: { where?: { kind?: string } }) =>
    args?.where?.kind === undefined ? rows : rows.filter((r) => r.kind === args.where?.kind),
  );
  const prisma = { erpDocument: { findMany } };
  const server = express();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) {
      (req as Request & { user?: unknown }).user = { id: "u-1", username: "stefan", displayName: "Stefan", role };
    }
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.use("/api", createMoneyRouter(prisma as any, () => NOW));
  return server;
}

beforeEach(() => {
  rows = [row()];
});

describe("GET /api/money", () => {
  it("answers an owner with per-ledger totals", async () => {
    const res = await request(app("owner")).get("/api/money");

    expect(res.status).toBe(200);
    expect(res.body.receivable.ledgers).toEqual([
      expect.objectContaining({ connectionId: "conn-1", balance: "1200.00", documentCount: 1 }),
    ]);
  });

  it("🔴 carries NO cross-ledger total for a caller to reach for", async () => {
    rows = [row(), row({ id: "doc-2", connectionId: "conn-2", externalSystem: "stripe" })];
    const res = await request(app("owner")).get("/api/money");

    expect(res.body.receivable.ledgers).toHaveLength(2);
    expect(res.body.receivable).not.toHaveProperty("total");
    expect(res.body.receivable).not.toHaveProperty("balance");
    expect(res.body).not.toHaveProperty("total");
  });

  it("says when it last read, and never that it is up to date", async () => {
    const res = await request(app("owner")).get("/api/money");
    expect(res.body.lastReadAt).toBe("2026-09-01T11:30:00.000Z");
    expect(JSON.stringify(res.body)).not.toMatch(/up to date|current|fresh/i);
  });

  it("admits the front desk — chasing an unpaid invoice is the ordinary use", async () => {
    const res = await request(app("family")).get("/api/money");
    expect(res.status).toBe(200);
  });

  it("refuses a guest", async () => {
    const res = await request(app("guest")).get("/api/money");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/money/documents", () => {
  it("hands money over as strings", async () => {
    const res = await request(app("admin")).get("/api/money/documents");

    expect(res.status).toBe(200);
    expect(res.body.documents[0]).toMatchObject({
      externalId: "INV-1001",
      amount: "4210.55",
      balance: "1200.00",
      isOverdue: true,
    });
    expect(typeof res.body.documents[0].amount).toBe("string");
  });

  it("reads the direction words a person would type", async () => {
    rows = [row(), row({ id: "doc-2", kind: "PAYABLE", externalId: "BILL-9" })];

    const owed = await request(app("owner")).get("/api/money/documents?kind=receivable");
    expect(owed.body.documents.map((d: { externalId: string }) => d.externalId)).toEqual([
      "INV-1001",
    ]);

    const owe = await request(app("owner")).get("/api/money/documents?kind=owed_by_us");
    expect(owe.body.documents.map((d: { externalId: string }) => d.externalId)).toEqual(["BILL-9"]);
  });

  it("ignores a direction it does not understand rather than guessing one", async () => {
    rows = [row(), row({ id: "doc-2", kind: "PAYABLE", externalId: "BILL-9" })];
    const res = await request(app("owner")).get("/api/money/documents?kind=sideways");
    expect(res.body.documents).toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("filters to overdue when asked", async () => {
    rows = [row(), row({ id: "doc-2", externalId: "INV-2", dueAt: new Date("2026-12-01T00:00:00Z") })];
    const res = await request(app("owner")).get("/api/money/documents?overdue=1");
    expect(res.body.documents.map((d: { externalId: string }) => d.externalId)).toEqual([
      "INV-1001",
    ]);
  });

  it("caps the page however large a caller asks", async () => {
    rows = Array.from({ length: 300 }, (_, i) => row({ id: `doc-${i}`, externalId: `INV-${i}` }));
    const res = await request(app("owner")).get("/api/money/documents?limit=100000");
    expect(res.body.documents).toHaveLength(200);
  });

  it("refuses a guest here too", async () => {
    const res = await request(app("guest")).get("/api/money/documents");
    expect(res.status).toBe(403);
  });
});
