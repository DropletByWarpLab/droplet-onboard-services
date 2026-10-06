/**
 * WARP-1453 — `email_search` LLM tool.
 *
 * The tool was structurally dead on the MCP service path: the
 * orchestrator route 403'd the `_service:mcp` principal and, even when
 * admitted, scoped accounts to the principal itself. The handler now
 * (1) gates on the forwarded human role (owner/admin/family — the
 * route's human set) with zero HTTP otherwise, and (2) forwards the
 * acting human as `X-Droplet-User` (AUTH_REQUIRED when absent).
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import emailSearch from "../../../src/handlers/email/search.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(opts: {
  get?: Mock;
  role?: Role;
  userId?: string;
}): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: opts.get ?? vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    signal: new AbortController().signal,
  };
}

const THREADS = [
  {
    id: "t1",
    subject: "Hello",
    lastSender: "a@b.com",
    snippet: "hi",
    lastMessageAt: "2026-07-20T10:00:00.000Z",
    triageStatus: "inbox",
    draftedByDroplet: false,
  },
];

function okGet(): Mock {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ filter: "inbox", threads: THREADS }), {
      status: 200,
    }),
  );
}

function expectError(
  res: Awaited<ReturnType<typeof emailSearch.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("email_search", () => {
  describe("role gate (WARP-1453)", () => {
    it.each([undefined, "guest"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await emailSearch.handler(
          { accountId: "a1" },
          ctxWith({ get, role, userId: "romain" }),
        );
        expectError(res, "FORBIDDEN");
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin", "family"] as const)(
      "role %s passes",
      async (role) => {
        const get = okGet();
        const res = await emailSearch.handler(
          { accountId: "a1" },
          ctxWith({ get, role, userId: "romain" }),
        );
        expect(res.ok).toBe(true);
      },
    );
  });

  it("missing ctx.userId → AUTH_REQUIRED with NO HTTP call", async () => {
    const get = vi.fn();
    const res = await emailSearch.handler(
      { accountId: "a1" },
      ctxWith({ get, role: "owner" }),
    );
    expectError(res, "AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("forwards X-Droplet-User on the threads call (WARP-1453)", async () => {
    const get = okGet();
    const res = await emailSearch.handler(
      { accountId: "a1", filter: "triaged", limit: 5 },
      ctxWith({ get, role: "family", userId: "romain" }),
    );
    expect(get).toHaveBeenCalledWith(
      "/api/email/a1/threads?filter=triaged&limit=5",
      {
        headers: { Accept: "application/json", "X-Droplet-User": "romain" },
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "email_search",
        filter: "inbox",
        threadCount: 1,
        threads: THREADS,
      });
    }
  });

  it("missing accountId → INVALID_ARGS with NO HTTP call", async () => {
    const get = vi.fn();
    const res = await emailSearch.handler(
      {},
      ctxWith({ get, role: "owner", userId: "romain" }),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("forwards a bounded local text query without turning its punctuation into URL parameters", async () => {
    const get = okGet();
    const res = await emailSearch.handler(
      { accountId: "outlook/1", query: "  renewal & June?  ", filter: "archived", limit: 10 },
      ctxWith({ get, role: "family", userId: "person-id" }),
    );
    expect(get).toHaveBeenCalledWith("/api/email/outlook%2F1/threads?filter=archived&limit=10&query=renewal+%26+June%3F", {
      headers: { Accept: "application/json", "X-Droplet-User": "person-id" },
    });
    expect(res.ok && res.data).toMatchObject({ query: "renewal & June?", threads: THREADS });
  });

  it.each(["x".repeat(201), 42, null])("refuses invalid query %s before HTTP", async (query) => {
    const get = vi.fn();
    const res = await emailSearch.handler({ accountId: "a1", query }, ctxWith({ get, role: "owner", userId: "romain" }));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps blank queries compatible with existing list behavior and admits the 200-character boundary", async () => {
    const get = okGet();
    await emailSearch.handler({ accountId: "a1", query: "  " }, ctxWith({ get, role: "owner", userId: "romain" }));
    expect(get.mock.calls[0][0]).toBe("/api/email/a1/threads?filter=inbox&limit=20");
    get.mockResolvedValue(new Response(JSON.stringify({ filter: "inbox", threads: [] })));
    expect((await emailSearch.handler({ accountId: "a1", query: "x".repeat(200) }, ctxWith({ get, role: "owner", userId: "romain" }))).ok).toBe(true);
    expect(new URL(get.mock.calls[1][0], "https://droplet.local").searchParams.get("query")).toHaveLength(200);
  });

  it("maps a non-OK response to EMAIL_SEARCH_FAILED", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 502 }));
    const res = await emailSearch.handler(
      { accountId: "a1" },
      ctxWith({ get, role: "owner", userId: "romain" }),
    );
    expectError(res, "EMAIL_SEARCH_FAILED");
  });
});
