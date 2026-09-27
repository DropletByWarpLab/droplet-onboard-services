/**
 * WARP-1452 / WARP-3102 — contacts, derived on read from indexed mail.
 *
 * There is no contacts table: this samples the most recent `EmailMessage` rows
 * of the named mailboxes whose sender matches the query and groups them by
 * lowercased address, returning address, most-recent non-empty display name,
 * last-seen timestamp, and message count, ranked by messageCount desc then
 * lastSeenAt desc.
 *
 * WARP-3102 moved this here from the tools-core `search_contacts` handler,
 * unchanged. The handler read `EmailAccount` itself by `userId: ctx.userId`,
 * which is a username on the stdio transport and a `User.id` over HTTP, while
 * the column holds a `User.id`. WHICH mailboxes are read is now the route's
 * decision (routes/email.ts `GET /email/contacts`); this only derives.
 *
 * Escalation path (deliberately out of scope here): if contact lookup ever
 * needs to be exact over full mailbox history rather than a 500-message
 * sample, materialize an EmailContact table maintained by the ingest pipeline
 * and point this at it — the route's and the tool's contracts would not change.
 */
import type { PrismaClient } from "@prisma/client";

/** Most recent messages to sample when deriving contacts. */
export const CONTACT_SAMPLE_SIZE = 500;

export interface DerivedContact {
  address: string;
  name: string | null;
  /** ISO timestamp of the most recent message from this address. */
  lastSeenAt: string;
  messageCount: number;
}

interface SenderRow {
  fromAddr: string;
  fromName: string | null;
  receivedAt: Date;
}

export async function deriveContacts(
  prisma: PrismaClient,
  accountIds: string[],
  query: string,
  limit: number,
): Promise<DerivedContact[]> {
  if (accountIds.length === 0) return [];

  // Sample the most recent matching senders; rows arrive receivedAt DESC,
  // so the first row per address is its most recent sighting.
  const rows = (await prisma.emailMessage.findMany({
    where: {
      accountId: { in: accountIds },
      OR: [
        { fromAddr: { contains: query, mode: "insensitive" } },
        { fromName: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { fromAddr: true, fromName: true, receivedAt: true },
    orderBy: { receivedAt: "desc" },
    take: CONTACT_SAMPLE_SIZE,
  })) as unknown as SenderRow[];

  const byAddress = new Map<
    string,
    { address: string; name: string | null; lastSeenAt: Date; messageCount: number }
  >();
  for (const row of rows) {
    const address = row.fromAddr.toLowerCase();
    const existing = byAddress.get(address);
    if (!existing) {
      byAddress.set(address, {
        address,
        name: row.fromName || null,
        lastSeenAt: row.receivedAt,
        messageCount: 1,
      });
    } else {
      existing.messageCount += 1;
      // Rows are newest-first: keep the first (= most recent) non-empty name.
      if (!existing.name && row.fromName) existing.name = row.fromName;
    }
  }

  return Array.from(byAddress.values())
    .sort(
      (a, b) =>
        b.messageCount - a.messageCount ||
        b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    )
    .slice(0, limit)
    .map((c) => ({
      address: c.address,
      name: c.name,
      lastSeenAt: c.lastSeenAt.toISOString(),
      messageCount: c.messageCount,
    }));
}
