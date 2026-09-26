/**
 * WARP-1452 — `search_contacts` LLM tool.
 *
 * Derive-on-read contact search over indexed mail: there is no contacts
 * table — the orchestrator samples the most recent EmailMessage rows whose
 * sender matches the query and groups them by lowercased address, returning
 * address, most-recent non-empty display name, last-seen timestamp, and
 * message count, ranked by messageCount desc then lastSeenAt desc
 * (apps/orchestrator/src/services/email/contacts.service.ts).
 *
 * WARP-3102 — the handler asks `GET /api/email/contacts` and forwards the
 * acting person as `X-Droplet-User` (`ctx.userId`), like the other five email
 * tools. It used to read `EmailAccount` itself through `ctx.prisma` by
 * `userId: ctx.userId`; that column holds a `User.id`, and `ctx.userId` is the
 * username on the stdio transport chat uses, so every chat user was told no
 * mailbox was connected. The route resolves either form, and decides which
 * mailboxes the person may read (owner/admin every one, family their own).
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

interface ContactsResponse {
  query: string;
  /** How many mailboxes the acting person may read. */
  accountCount: number;
  contacts: Array<{ address: string; name: string | null; lastSeenAt: string; messageCount: number }>;
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

  const params = new URLSearchParams({ query, limit: String(limit) });
  const res = await ctx.http.orchestrator.get(
    `/api/email/contacts?${params.toString()}`,
    // X-Droplet-User carries the acting person — a username on stdio, a
    // User.id over HTTP; the orchestrator honors it ONLY for the trusted mcp
    // principal and resolves either.
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (res.status === 403) {
    return err("FORBIDDEN", "contact search is not available to this user");
  }
  if (!res.ok) {
    return err("CONTACT_SEARCH_FAILED", `orchestrator returned ${res.status}`);
  }
  const data = (await res.json()) as ContactsResponse;
  if (data.accountCount === 0) {
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
  return {
    ok: true,
    data: {
      type: "search_contacts",
      contacts: data.contacts,
      count: data.contacts.length,
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
