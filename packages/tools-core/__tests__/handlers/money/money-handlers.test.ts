/**
 * WARP-2581 — `money_list_open_documents`.
 *
 * Two assertions here exist because a review caught the tool borrowing the
 * CRM's answers:
 *
 *   • the failure codes were CRM_*, so a money question that failed reported
 *     itself as a customer-record problem;
 *   • `last_read` was the FIRST row's read time, and `/api/money/documents`
 *     orders by due date — so the tool reported the soonest-due document's
 *     read time as if it were the box's.
 *
 * The rest pin what this tool refuses to do: no total, money as strings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ToolContext } from "../../../src/types.js";
import moneyListOpenDocuments from "../../../src/handlers/money/list-open-documents.js";

const get = vi.fn();
const ctx = {
  http: { orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
} as unknown as ToolContext;

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

function wireDoc(over: Record<string, unknown> = {}) {
  return {
    externalId: "INV-1001",
    kind: "RECEIVABLE",
    counterparty: { name: "Example Roofing", externalId: "cust-7" },
    dueAt: "2026-09-30T00:00:00.000Z",
    amount: "4210.55",
    balance: "1200.00",
    currency: null,
    status: "Open",
    isOverdue: false,
    externalSystem: "quickbooks-online",
    lastReadAt: "2026-09-01T11:00:00.000Z",
    ...over,
  };
}

function errorOf(result: unknown): { code: string; message: string } {
  return (result as { error: { code: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shape", () => {
  it("is read-only and ungated", () => {
    expect(moneyListOpenDocuments.requiresWrite).toBe(false);
    expect(moneyListOpenDocuments.requiresConfirmation).toBe(false);
  });

  it("carries money across as strings and offers no total to reach for", async () => {
    get.mockResolvedValue(res(true, 200, { documents: [wireDoc({ amount: "90071992547409.93" })] }));
    const out = await moneyListOpenDocuments.handler({}, ctx);

    expect(out.ok).toBe(true);
    const data = (out as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("total");
    const documents = data.documents as Array<Record<string, unknown>>;
    expect(documents[0].amount).toBe("90071992547409.93");
    expect(typeof documents[0].amount).toBe("string");
  });
});

describe("last_read", () => {
  it("🔴 reports the NEWEST read, not whichever document happened to sort first", async () => {
    // `/api/money/documents` orders by `dueAt asc, externalId asc`, so
    // `documents[0]` is the soonest-DUE row. Its read time is an arbitrary
    // one, and reporting it understates how recently the box read.
    get.mockResolvedValue(
      res(true, 200, {
        documents: [
          wireDoc({ externalId: "INV-1", dueAt: "2026-09-02T00:00:00.000Z", lastReadAt: "2026-08-25T09:00:00.000Z" }),
          wireDoc({ externalId: "INV-2", dueAt: "2026-09-30T00:00:00.000Z", lastReadAt: "2026-09-01T11:00:00.000Z" }),
        ],
      }),
    );

    const out = await moneyListOpenDocuments.handler({}, ctx);
    expect((out as { data: { last_read: string | null } }).data.last_read).toBe(
      "2026-09-01T11:00:00.000Z",
    );
  });

  it("says nothing about a read it cannot date", async () => {
    get.mockResolvedValue(res(true, 200, { documents: [] }));
    const out = await moneyListOpenDocuments.handler({}, ctx);
    expect((out as { data: { last_read: string | null } }).data.last_read).toBeNull();

    get.mockResolvedValue(
      res(true, 200, { documents: [wireDoc({ lastReadAt: "not a timestamp" })] }),
    );
    const bad = await moneyListOpenDocuments.handler({}, ctx);
    expect((bad as { data: { last_read: string | null } }).data.last_read).toBeNull();
  });
});

describe("failures", () => {
  it("🔴 never reports a money failure under a CRM code", async () => {
    for (const status of [404, 422, 500, 504]) {
      get.mockResolvedValue(res(false, status, { error: "boom" }));
      const out = await moneyListOpenDocuments.handler({}, ctx);
      expect(out.ok).toBe(false);
      expect(errorOf(out).code, `status ${status}`).not.toMatch(/^CRM_/);
      expect(errorOf(out).code, `status ${status}`).toMatch(/^MONEY_/);
    }
  });

  it("keeps the module gate distinguishable from a broken ledger", async () => {
    // 404 here is the `money` module being off, not a missing record — the
    // route is gated by `routePrefixes` and simply does not exist.
    get.mockResolvedValue(res(false, 404, { error: "not_found" }));
    expect(errorOf(await moneyListOpenDocuments.handler({}, ctx)).code).toBe("MONEY_NOT_AVAILABLE");

    get.mockResolvedValue(res(false, 403, { error: "forbidden" }));
    expect(errorOf(await moneyListOpenDocuments.handler({}, ctx)).code).toBe("MONEY_FORBIDDEN");

    get.mockResolvedValue(res(false, 422, { error: "bad_kind" }));
    const invalid = await moneyListOpenDocuments.handler({}, ctx);
    expect(errorOf(invalid).code).toBe("MONEY_INVALID_REQUEST");
    // A 422 names a fixable mistake, so the message survives for the model.
    expect(errorOf(invalid).message).toBe("bad_kind");

    get.mockResolvedValue(res(false, 500, { error: "boom" }));
    expect(errorOf(await moneyListOpenDocuments.handler({}, ctx)).code).toBe("MONEY_API_ERROR");
  });

  it("lets a programming mistake bubble instead of flattening it into a tool failure", async () => {
    get.mockRejectedValue(new TypeError("undefined is not a function"));
    await expect(moneyListOpenDocuments.handler({}, ctx)).rejects.toThrow(TypeError);
  });
});
