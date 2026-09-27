/**
 * WARP-1452 / WARP-3102 — contacts derived on read from indexed mail.
 *
 * The derivation moved here from the tools-core `search_contacts` handler
 * unchanged; which mailboxes it reads is the route's decision
 * (routes/email.ts `GET /email/contacts`).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { CONTACT_SAMPLE_SIZE, deriveContacts } from "./contacts.service.js";

function prismaWith(rows: Array<{ fromAddr: string; fromName: string | null; receivedAt: Date }>) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return { prisma: { emailMessage: { findMany } } as unknown as PrismaClient, findMany };
}

describe("deriveContacts", () => {
  it("reads nothing when there is no mailbox to read", async () => {
    const { prisma, findMany } = prismaWith([]);
    expect(await deriveContacts(prisma, [], "bob", 10)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("samples the newest matching senders of the named mailboxes, case-insensitively", async () => {
    const { prisma, findMany } = prismaWith([]);
    await deriveContacts(prisma, ["a1", "a2"], "bob", 10);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        accountId: { in: ["a1", "a2"] },
        OR: [
          { fromAddr: { contains: "bob", mode: "insensitive" } },
          { fromName: { contains: "bob", mode: "insensitive" } },
        ],
      },
      select: { fromAddr: true, fromName: true, receivedAt: true },
      orderBy: { receivedAt: "desc" },
      take: CONTACT_SAMPLE_SIZE,
    });
    expect(CONTACT_SAMPLE_SIZE).toBe(500);
  });

  it("groups by lowercased address, keeps the most recent non-empty name, counts and ranks", async () => {
    // Rows arrive receivedAt DESC, exactly as the query orders them.
    const { prisma } = prismaWith([
      { fromAddr: "Bob@Example.com", fromName: null, receivedAt: new Date("2026-07-04T00:00:00Z") },
      { fromAddr: "alice.b@example.com", fromName: "Alice Bobson", receivedAt: new Date("2026-07-03T00:00:00Z") },
      { fromAddr: "bob@example.com", fromName: "Bobby", receivedAt: new Date("2026-07-02T00:00:00Z") },
      { fromAddr: "BOB@EXAMPLE.COM", fromName: "Bob Old", receivedAt: new Date("2026-07-01T00:00:00Z") },
    ]);
    expect(await deriveContacts(prisma, ["a1"], "bob", 10)).toEqual([
      // Three messages once casing is folded → first. The newest row has no
      // name; the newest NON-EMPTY name wins.
      { address: "bob@example.com", name: "Bobby", lastSeenAt: "2026-07-04T00:00:00.000Z", messageCount: 3 },
      { address: "alice.b@example.com", name: "Alice Bobson", lastSeenAt: "2026-07-03T00:00:00.000Z", messageCount: 1 },
    ]);
  });

  it("breaks messageCount ties by lastSeenAt desc and honours the limit", async () => {
    const { prisma } = prismaWith([
      { fromAddr: "new@example.com", fromName: "New", receivedAt: new Date("2026-07-10T00:00:00Z") },
      { fromAddr: "old@example.com", fromName: "Old", receivedAt: new Date("2026-07-01T00:00:00Z") },
    ]);
    expect((await deriveContacts(prisma, ["a1"], "example", 10)).map((c) => c.address)).toEqual([
      "new@example.com",
      "old@example.com",
    ]);
    expect((await deriveContacts(prisma, ["a1"], "example", 1)).map((c) => c.address)).toEqual(["new@example.com"]);
  });
});
