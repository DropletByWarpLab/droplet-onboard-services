/**
 * WARP-1452 / WARP-3102 — `search_contacts` LLM tool.
 *
 * Until WARP-3102 the handler read `EmailAccount` through `ctx.prisma` by
 * `userId: ctx.userId`. The column holds a `User.id`, while `ctx.userId` is the
 * username on the stdio transport chat uses, so every chat user was told no
 * mailbox was connected. The handler now asks the orchestrator
 * (`GET /api/email/contacts`), which resolves the acting person and derives the
 * contacts from the mailboxes they may read; the derivation itself is tested in
 * apps/orchestrator/src/services/email/contacts.service.test.ts, and the handler
 * against the real router in apps/orchestrator/src/__tests__/
 * email-tools-acting-user.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import searchContacts from "../../../src/handlers/email/search-contacts.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(opts: { get?: Mock; userId?: string; prisma?: unknown } = {}): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get: opts.get ?? vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: (opts.prisma ?? {}) as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: opts.userId === undefined ? "alice" : opts.userId,
    signal: new AbortController().signal,
  };
}

const CONTACTS = [
  { address: "bob@example.com", name: "Bob Lee", lastSeenAt: "2026-07-04T00:00:00.000Z", messageCount: 3 },
  { address: "bobbi@vendor.test", name: null, lastSeenAt: "2026-07-03T00:00:00.000Z", messageCount: 1 },
];

function answer(status: number, body: unknown): Mock {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("search_contacts", () => {
  it("requires an acting user, and sends nothing without one", async () => {
    const get = vi.fn();
    const r = await searchContacts.handler({ query: "bob" }, ctxWith({ get, userId: "" }));
    expect(r).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("asks the orchestrator, forwarding the acting user and the query", async () => {
    const get = answer(200, { query: "bob", accountCount: 2, contacts: CONTACTS });
    await searchContacts.handler({ query: "  bob ", limit: 5 }, ctxWith({ get, userId: "u-1234" }));

    expect(get).toHaveBeenCalledTimes(1);
    const [path, opts] = get.mock.calls[0] as [string, { headers: Record<string, string> }];
    const url = new URL(path, "http://orchestrator");
    expect(url.pathname).toBe("/api/email/contacts");
    expect(url.searchParams.get("query")).toBe("bob");
    expect(url.searchParams.get("limit")).toBe("5");
    // Whatever the transport put in ctx.userId — a username or a User.id — is
    // forwarded as is; the orchestrator resolves it.
    expect(opts.headers["X-Droplet-User"]).toBe("u-1234");
  });

  it("defaults the limit to 10", async () => {
    const get = answer(200, { query: "bob", accountCount: 1, contacts: [] });
    await searchContacts.handler({ query: "bob" }, ctxWith({ get }));
    const [path] = get.mock.calls[0] as [string];
    expect(new URL(path, "http://orchestrator").searchParams.get("limit")).toBe("10");
  });

  it("returns the orchestrator's contacts in the tool's shape", async () => {
    const get = answer(200, { query: "bob", accountCount: 2, contacts: CONTACTS });
    const r = await searchContacts.handler({ query: "bob" }, ctxWith({ get }));
    expect(r).toEqual({
      ok: true,
      data: { type: "search_contacts", contacts: CONTACTS, count: 2, query: "bob" },
    });
  });

  it("says so when the person has no mailbox connected", async () => {
    const get = answer(200, { query: "bob", accountCount: 0, contacts: [] });
    const r = await searchContacts.handler({ query: "bob" }, ctxWith({ get }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { contacts: unknown[]; count: number; note?: string };
      expect(data.contacts).toEqual([]);
      expect(data.count).toBe(0);
      expect(data.note).toMatch(/No email accounts are connected/);
    }
  });

  it("a 403 (nobody, or a person outside the route's roles) is a FORBIDDEN refusal", async () => {
    const r = await searchContacts.handler({ query: "bob" }, ctxWith({ get: answer(403, { error: "forbidden" }) }));
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("any other failure is an error the model can report, never an empty list", async () => {
    for (const status of [401, 404, 500, 503]) {
      const r = await searchContacts.handler({ query: "bob" }, ctxWith({ get: answer(status, {}) }));
      expect(r, String(status)).toMatchObject({ ok: false, error: { code: "CONTACT_SEARCH_FAILED" } });
    }
  });

  it("never reads the email tables itself", async () => {
    const refuse = vi.fn(async () => {
      throw new Error("read through ctx.prisma");
    });
    const get = answer(200, { query: "bob", accountCount: 1, contacts: CONTACTS });
    await searchContacts.handler(
      { query: "bob" },
      ctxWith({ get, prisma: { emailAccount: { findMany: refuse }, emailMessage: { findMany: refuse } } }),
    );
    expect(refuse).not.toHaveBeenCalled();
  });

  it("rejects a missing/empty/over-long query before any HTTP", async () => {
    const get = vi.fn();
    for (const args of [{}, { query: "" }, { query: "   " }, { query: "x".repeat(121) }, { query: 42 }]) {
      const r = await searchContacts.handler(args as Record<string, unknown>, ctxWith({ get }));
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or non-integer limit before any HTTP", async () => {
    const get = vi.fn();
    for (const limit of [0, 26, 1.5, "five"]) {
      const r = await searchContacts.handler({ query: "bob", limit }, ctxWith({ get }));
      expect(r, String(limit)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("metadata: Tier-1 read-only, query required, no extra args", () => {
    expect(searchContacts.name).toBe("search_contacts");
    expect(searchContacts.requiresWrite).toBe(false);
    expect(searchContacts.requiresConfirmation).toBe(false);
    const schema = searchContacts.inputSchema as {
      required?: readonly string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "query"]);
  });
});
