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
import type { ToolContext, ToolResult } from "../../types.js";

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

export type RecipientPreview =
  | { ok: true; usernames: string[]; names: string[] }
  | { ok: false; result: ToolResult };

/**
 * Phase 1 (the approval copy): drop the sender by id and show DISPLAY
 * NAMES where the roster knows them. An unknown username stays as typed —
 * phase 2 refuses it loudly. Naming only the sender is refused here, so
 * the user is never asked to approve a send that cannot happen.
 */
export function previewRecipients(
  roster: { contacts: RosterContact[]; meId: string },
  usernames: string[],
): RecipientPreview {
  const byUsername = new Map(
    roster.contacts.flatMap((c) => (c.username ? [[c.username, c] as const] : [])),
  );
  const others = usernames.filter((u) => byUsername.get(u)?.id !== roster.meId);
  if (others.length === 0) {
    return { ok: false, result: err("INVALID_ARGS", SELF_ONLY_MESSAGE) };
  }
  return {
    ok: true,
    usernames: others,
    names: others.map((u) => {
      const display = byUsername.get(u)?.displayName;
      return display && display.length > 0 ? display : u;
    }),
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
