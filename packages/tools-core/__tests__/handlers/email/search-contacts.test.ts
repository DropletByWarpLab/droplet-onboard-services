import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import searchContacts from "../../../src/handlers/email/search-contacts.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  mocks: {
    accountFindMany?: Mock;
    messageFindMany?: Mock;
  },
  userId?: string,
): ToolContext {
  return {
    prisma: {
      emailAccount: { findMany: mocks.accountFindMany ?? vi.fn() },
      emailMessage: { findMany: mocks.messageFindMany ?? vi.fn() },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId === undefined ? "alice" : userId,
    signal: new AbortController().signal,
  };
}

describe("search_contacts", () => {
  it("requires auth", async () => {
    const accountFindMany = vi.fn();
    const r = await searchContacts.handler({ query: "bob" }, ctxWith({ accountFindMany }, ""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty success with a note when the user has no email accounts", async () => {
    const accountFindMany = vi.fn().mockResolvedValue([]);
    const messageFindMany = vi.fn();
    const r = await searchContacts.handler(
      { query: "bob" },
      ctxWith({ accountFindMany, messageFindMany }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        type: string;
        contacts: unknown[];
        count: number;
        query: string;
        note?: string;
      };
      expect(data.type).toBe("search_contacts");
      expect(data.contacts).toEqual([]);
      expect(data.count).toBe(0);
      expect(data.query).toBe("bob");
      expect(typeof data.note).toBe("string");
      expect(data.note?.length).toBeGreaterThan(0);
    }
    expect(accountFindMany).toHaveBeenCalledWith({
      where: { userId: "alice" },
      select: { id: true },
    });
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it("scopes the message query to the caller's accountIds with a case-insensitive OR", async () => {
    const accountFindMany = vi.fn().mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    const messageFindMany = vi.fn().mockResolvedValue([]);
    const r = await searchContacts.handler(
      { query: "bob" },
      ctxWith({ accountFindMany, messageFindMany }),
    );
    expect(r.ok).toBe(true);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        accountId: { in: ["a1", "a2"] },
        OR: [
          { fromAddr: { contains: "bob", mode: "insensitive" } },
          { fromName: { contains: "bob", mode: "insensitive" } },
        ],
      },
      select: { fromAddr: true, fromName: true, receivedAt: true },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
  });

  it("groups by lowercased address, keeps the most recent non-empty name, counts and ranks", async () => {
    const accountFindMany = vi.fn().mockResolvedValue([{ id: "a1" }]);
    // Rows arrive receivedAt DESC, exactly as the prisma query orders them.
    const messageFindMany = vi.fn().mockResolvedValue([
      { fromAddr: "Bob@Example.com", fromName: null, receivedAt: new Date("2026-07-04T00:00:00Z") },
      { fromAddr: "alice.b@example.com", fromName: "Alice Bobson", receivedAt: new Date("2026-07-03T00:00:00Z") },
      { fromAddr: "bob@example.com", fromName: "Bobby", receivedAt: new Date("2026-07-02T00:00:00Z") },
      { fromAddr: "BOB@EXAMPLE.COM", fromName: "Bob Old", receivedAt: new Date("2026-07-01T00:00:00Z") },
    ]);
    const r = await searchContacts.handler(
      { query: "bob" },
      ctxWith({ accountFindMany, messageFindMany }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as {
        count: number;
        contacts: Array<{
          address: string;
          name: string | null;
          lastSeenAt: string;
          messageCount: number;
        }>;
      };
      expect(data.count).toBe(2);
      // bob@ has 3 messages (casing folded) → ranks first.
      expect(data.contacts[0]).toEqual({
        address: "bob@example.com",
        // Most recent row has no name; most recent NON-EMPTY name wins.
        name: "Bobby",
        lastSeenAt: "2026-07-04T00:00:00.000Z",
        messageCount: 3,
      });
      expect(data.contacts[1]).toEqual({
        address: "alice.b@example.com",
        name: "Alice Bobson",
        lastSeenAt: "2026-07-03T00:00:00.000Z",
        messageCount: 1,
      });
    }
  });

  it("breaks messageCount ties by lastSeenAt desc and honors limit", async () => {
    const accountFindMany = vi.fn().mockResolvedValue([{ id: "a1" }]);
    const messageFindMany = vi.fn().mockResolvedValue([
      { fromAddr: "new@example.com", fromName: "New", receivedAt: new Date("2026-07-10T00:00:00Z") },
      { fromAddr: "old@example.com", fromName: "Old", receivedAt: new Date("2026-07-01T00:00:00Z") },
    ]);
    const both = await searchContacts.handler(
      { query: "example" },
      ctxWith({ accountFindMany, messageFindMany }),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      const data = both.data as { contacts: Array<{ address: string }> };
      expect(data.contacts.map((c) => c.address)).toEqual([
        "new@example.com",
        "old@example.com",
      ]);
    }
    const limited = await searchContacts.handler(
      { query: "example", limit: 1 },
      ctxWith({ accountFindMany, messageFindMany }),
    );
    expect(limited.ok).toBe(true);
    if (limited.ok) {
      const data = limited.data as { count: number; contacts: Array<{ address: string }> };
      expect(data.count).toBe(1);
      expect(data.contacts.map((c) => c.address)).toEqual(["new@example.com"]);
    }
  });

  it("rejects a missing/empty/over-long query before touching Prisma", async () => {
    const accountFindMany = vi.fn();
    for (const args of [{}, { query: "" }, { query: "x".repeat(121) }, { query: 42 }]) {
      const r = await searchContacts.handler(
        args as Record<string, unknown>,
        ctxWith({ accountFindMany }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or non-integer limit before touching Prisma", async () => {
    const accountFindMany = vi.fn();
    for (const limit of [0, 26, 1.5, "five"]) {
      const r = await searchContacts.handler(
        { query: "bob", limit },
        ctxWith({ accountFindMany }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(accountFindMany).not.toHaveBeenCalled();
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
