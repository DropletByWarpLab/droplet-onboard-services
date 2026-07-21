/**
 * WARP-1452 — `search_contacts` LLM tool.
 *
 * Derive-on-read contact search over indexed mail: there is no contacts
 * table — the handler samples the caller's most recent EmailMessage rows
 * whose sender matches the query and groups them by lowercased address,
 * returning address, most-recent non-empty display name, last-seen
 * timestamp, and message count, ranked by messageCount desc then
 * lastSeenAt desc.
 *
 * Escalation path (deliberately out of scope here): if contact lookup
 * ever needs to be exact over full mailbox history rather than a
 * 500-message sample, materialize an EmailContact table maintained by
 * the ingest pipeline and point this handler at it — the tool's input
 * and output contracts would not change.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description: "Name or address fragment to match against email senders (case-insensitive).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 25,
      description: "Max contacts to return (default 10).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** Most recent messages to sample when deriving contacts. */
const SAMPLE_SIZE = 500;

interface SenderRow {
  fromAddr: string;
  fromName: string | null;
  receivedAt: Date;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 120) return err("INVALID_ARGS", "query must be 1-120 chars");
  let limit = 10;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25)
      return err("INVALID_ARGS", "limit must be an integer 1-25");
    limit = args.limit;
  }

  const accounts = (await ctx.prisma.emailAccount.findMany({
    where: { userId: ctx.userId },
    select: { id: true },
  })) as Array<{ id: string }>;
  if (accounts.length === 0) {
    return {
      ok: true,
      data: {
        type: "search_contacts",
        contacts: [],
        count: 0,
        query,
        note: "No email accounts are connected for this user, so there is no indexed mail to derive contacts from.",
      },
    };
  }

  // Sample the most recent matching senders; rows arrive receivedAt DESC,
  // so the first row per address is its most recent sighting.
  const rows = (await ctx.prisma.emailMessage.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      OR: [
        { fromAddr: { contains: query, mode: "insensitive" } },
        { fromName: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { fromAddr: true, fromName: true, receivedAt: true },
    orderBy: { receivedAt: "desc" },
    take: SAMPLE_SIZE,
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

  const contacts = Array.from(byAddress.values())
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

  return {
    ok: true,
    data: {
      type: "search_contacts",
      contacts,
      count: contacts.length,
      query,
    },
  };
}

const tool: Tool = {
  name: "search_contacts",
  description:
    "Find people you correspond with — searches the senders of your indexed email by name or address fragment and returns each match's address, display name, last-seen date, and message count. Useful for resolving a person to an email address before email_send or email_draft_reply.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
