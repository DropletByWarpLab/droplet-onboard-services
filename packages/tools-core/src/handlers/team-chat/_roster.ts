/**
 * WARP-1685 — shared PURE helpers for the team-chat send tools.
 *
 * Both tools dispatch through the orchestrator's /api/team-chat routes as
 * the trusted `_service:mcp` principal, acting as the human named by
 * X-Droplet-User = ctx.userId (the exact email-tool posture from
 * handlers/email/send.ts). That is `User.username` on stdio (MCP
 * `_meta.userId`) and `User.id` over HTTP (`claims.sub`); the orchestrator
 * resolves either against the directory (resolveAssertedUser, WARP-3187)
 * and runs the IDENTICAL participant/module checks a direct human call
 * gets — these helpers only carry the identity, they never widen it.
 *
 * DELIBERATELY NO `ctx.http` CALLS IN THIS FILE: the WARP-1455
 * TOOL_ROUTES drift gate discovers a tool's route hops by scanning the
 * HANDLER source file, so every dispatch lives in the handler itself and
 * this module only validates inputs and maps responses.
 */
import type { Tool, ToolContext, ToolHandler, ToolResult } from "../../types.js";

export function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/** Every orchestrator call the team-chat tools make carries the acting
 *  human. Callers must have refused `!ctx.userId` already (fail closed). */
export function actingHeaders(ctx: ToolContext): Record<string, string> {
  return { Accept: "application/json", "X-Droplet-User": ctx.userId ?? "" };
}

/** Truncate user text for confirmation previews — the full body still
 *  goes out on phase 2; the preview just has to be scannable. */
export function truncateForPreview(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Minimal structural Response shape (satisfied by fetch's Response). */
export interface TeamChatHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

const UNAVAILABLE_MESSAGE =
  "Messages is unavailable — the Messages module may be turned off in Settings → Modules.";

/** The roster row shape GET /api/team-chat/contacts serves. `username` is
 *  absent for an external guest caller, who gets names only (WARP-3263). */
export interface RosterContact {
  id: string;
  displayName: string;
  username?: string;
}

export type RosterRead =
  | { ok: true; contacts: RosterContact[]; meId: string; canStartConversation: boolean }
  | { ok: false; result: ToolResult };

const GUEST_CANNOT_START_MESSAGE =
  "External guests can't start a conversation. They can only reply in one a member started (pass its thread_id).";

/**
 * Map the roster response. A 404 is the team_chat module gate.
 *
 * WARP-3196 — `meId` is the User.id of the person the orchestrator resolved
 * from X-Droplet-User (the response's `me`). It is the only name for the
 * sender that is the same on both MCP transports: ctx.userId is
 * User.username on stdio and User.id over HTTP, so it is never compared
 * with a recipient. A roster without it cannot say who is sending, so it
 * fails closed.
 */
export async function readRosterResponse(
  res: TeamChatHttpResponse,
): Promise<RosterRead> {
  if (res.status === 404) {
    return { ok: false, result: err("TEAM_CHAT_UNAVAILABLE", UNAVAILABLE_MESSAGE) };
  }
  if (res.status === 401) {
    return { ok: false, result: err("AUTH_REQUIRED", "auth_required") };
  }
  if (!res.ok) {
    return {
      ok: false,
      result: err("TEAM_CHAT_SEND_FAILED", `orchestrator returned ${res.status}`),
    };
  }
  const body = (await res.json().catch(() => null)) as {
    contacts?: RosterContact[];
    me?: { id?: unknown };
    canStartConversation?: boolean;
  } | null;
  const meId = body?.me?.id;
  if (typeof meId !== "string" || meId.length === 0) {
    return {
      ok: false,
      result: err("TEAM_CHAT_SEND_FAILED", "orchestrator did not say who is sending"),
    };
  }
  return {
    ok: true,
    contacts: body?.contacts ?? [],
    meId,
    // WARP-3263 — stated by the orchestrator, never inferred from a
    // names-only roster. Absent (an older orchestrator) means allowed.
    canStartConversation: body?.canStartConversation !== false,
  };
}

const SELF_ONLY_MESSAGE = "recipients must include someone other than yourself";

/**
 * Recipients → the roster rows the thread is with (sender dropped, unknown
 * names refused), shared by both send tools in both phases. WARP-3349: the
 * roster has no email column (User.email is encrypted at rest, WARP-233),
 * so a recipient that is not a username but is shaped like an address is
 * looked up by the orchestrator (`findUserByEmail`, the blind index) and
 * replaced by that person's username, a member's or an external guest's.
 * `lookup` is the handler's own POST /api/team-chat/contacts/lookup (the
 * route path has to stay in the handler file for the WARP-1455 drift gate);
 * the addresses go in its body, never a URL, so they stay out of the
 * request log. A guest caller is never looked up for; resolveRecipients
 * answers with the rule.
 */
export async function resolveTargets(
  roster: { contacts: RosterContact[]; meId: string; canStartConversation: boolean },
  recipients: string[],
  lookup: (emails: string[]) => Promise<TeamChatHttpResponse>,
): Promise<RecipientResolution> {
  const addresses = addressesToLookUp(roster, recipients);
  if (addresses.length > 0 && roster.canStartConversation) {
    const looked = await readLookupResponse(await lookup(addresses), recipients, addresses);
    if (!looked.ok) return looked;
    recipients = looked.usernames;
  }
  return resolveRecipients(roster, recipients);
}

/**
 * WARP-3349 / WARP-3403 — a send tool's `precheck`: its own unconfirmed
 * phase, run before the interceptor asks, so a refusal reaches the model
 * instead of an approval card for a send that cannot happen. `confirmed`
 * is forced false, so this can never reach the confirmed phase's writes,
 * whatever the model passed.
 */
export function unconfirmedPhaseAsPrecheck(handler: ToolHandler): NonNullable<Tool["precheck"]> {
  return async (args, ctx) => {
    const r = await handler({ ...args, confirmed: false }, ctx);
    return !r.ok && r.status === "error" ? { ok: false, status: "error", error: r.error } : null;
  };
}

/** `local@domain.tld`, within the lookup route's 320-character limit. */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * WARP-3349 — the recipients to look up as someone's email address:
 * those that match no roster username and are shaped like an address.
 * Usernames never contain "@" (invite, SSO and SCIM keep [A-Za-z0-9._-]),
 * and a roster username still wins, so a typed username never takes this
 * path. Anything else ("@bob", an oversized string) stays a username and
 * fails as UNKNOWN_RECIPIENT.
 */
export function addressesToLookUp(
  roster: { contacts: RosterContact[] },
  recipients: string[],
): string[] {
  const usernames = new Set(roster.contacts.flatMap((c) => (c.username ? [c.username] : [])));
  return recipients.filter(
    (r) => !usernames.has(r) && r.length <= 320 && ADDRESS_SHAPE.test(r),
  );
}

export type AddressLookup =
  | { ok: true; usernames: string[] }
  | { ok: false; result: ToolResult };

/**
 * WARP-3349 — map POST /api/team-chat/contacts/lookup (one row or `null`
 * per address, in order) back onto `recipients`: each address becomes its
 * person's username, deduplicated, so "dave" and "dave@company.com" are one
 * person. The route answers for everyone ACTIVE in the Workspace, external
 * guests included (Romain, 2026-09-30). An address that is nobody's there
 * is refused, and the model is told to offer email instead (Romain,
 * 2026-09-29: team chat by default, email only when the person asks).
 */
export async function readLookupResponse(
  res: TeamChatHttpResponse,
  recipients: string[],
  addresses: string[],
): Promise<AddressLookup> {
  if (res.status === 404) {
    return { ok: false, result: err("TEAM_CHAT_UNAVAILABLE", UNAVAILABLE_MESSAGE) };
  }
  if (res.status === 401) {
    return { ok: false, result: err("AUTH_REQUIRED", "auth_required") };
  }
  const body = res.ok
    ? ((await res.json().catch(() => null)) as { contacts?: (RosterContact | null)[] } | null)
    : null;
  const rows = body?.contacts;
  if (!Array.isArray(rows) || rows.length !== addresses.length) {
    return {
      ok: false,
      result: err("TEAM_CHAT_SEND_FAILED", `orchestrator returned ${res.status}`),
    };
  }
  const byAddress = new Map(addresses.map((a, i) => [a, rows[i]?.username ?? null]));
  const outside = addresses.filter((a) => byAddress.get(a) === null);
  if (outside.length > 0) {
    return {
      ok: false,
      result: err(
        "RECIPIENT_NOT_A_MEMBER",
        `${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} in this Workspace; team chat only reaches people in it — ask the user whether to email them instead.`,
      ),
    };
  }
  return {
    ok: true,
    usernames: [...new Set(recipients.map((r) => byAddress.get(r) ?? r))],
  };
}

export type RecipientResolution =
  | { ok: true; others: RosterContact[] }
  | { ok: false; result: ToolResult };

/**
 * Phase 2: resolve recipient USERNAMES to roster rows and drop the sender
 * BY ID (`meId`). Unknown names fail loudly BEFORE any thread exists, and
 * so does a list that names only the sender. `others` are the people the
 * thread is with; their count decides direct vs group.
 */
export function resolveRecipients(
  roster: { contacts: RosterContact[]; meId: string; canStartConversation: boolean },
  usernames: string[],
): RecipientResolution {
  if (!roster.canStartConversation) {
    return {
      ok: false,
      result: err("GUEST_CANNOT_START_CONVERSATION", GUEST_CANNOT_START_MESSAGE),
    };
  }
  const byUsername = new Map(
    roster.contacts.flatMap((c) => (c.username ? [[c.username, c] as const] : [])),
  );
  const missing = usernames.filter((u) => !byUsername.has(u));
  if (missing.length > 0) {
    return {
      ok: false,
      result: err(
        "UNKNOWN_RECIPIENT",
        `No member named: ${missing.join(", ")}. Recipients must be existing member usernames.`,
      ),
    };
  }
  const others = usernames
    .map((u) => byUsername.get(u)!)
    .filter((c) => c.id !== roster.meId);
  if (others.length === 0) {
    return { ok: false, result: err("INVALID_ARGS", SELF_ONLY_MESSAGE) };
  }
  return { ok: true, others };
}

export type ThreadRead =
  | { ok: true; threadId: string }
  | { ok: false; result: ToolResult };

/**
 * Map the POST /api/team-chat/threads response (200 = existing direct
 * pair, 201 = new thread). NOTE: group threads are NOT deduped by the
 * orchestrator (v1 semantics) — repeat group sends to the same set mint a
 * new thread; follow-ups should pass thread_id instead.
 */
export async function readThreadResponse(
  res: TeamChatHttpResponse,
): Promise<ThreadRead> {
  if (res.status === 404) {
    return { ok: false, result: err("TEAM_CHAT_UNAVAILABLE", UNAVAILABLE_MESSAGE) };
  }
  if (res.status === 401) {
    return { ok: false, result: err("AUTH_REQUIRED", "auth_required") };
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      result: err("INVALID_ARGS", body?.error ?? "invalid thread request"),
    };
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "guest_cannot_start_conversation") {
      return {
        ok: false,
        result: err("GUEST_CANNOT_START_CONVERSATION", GUEST_CANNOT_START_MESSAGE),
      };
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      result: err("TEAM_CHAT_SEND_FAILED", `orchestrator returned ${res.status}`),
    };
  }
  const body = (await res.json().catch(() => null)) as {
    thread?: { id?: string };
  } | null;
  const threadId = body?.thread?.id;
  if (!threadId) {
    return {
      ok: false,
      result: err("TEAM_CHAT_SEND_FAILED", "orchestrator returned no thread id"),
    };
  }
  return { ok: true, threadId };
}
