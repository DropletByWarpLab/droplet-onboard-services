/**
 * WARP-1685 — shared PURE helpers for the team-chat send tools.
 *
 * Both tools dispatch through the orchestrator's /api/team-chat routes as
 * the trusted `_service:mcp` principal, acting as the human named by
 * X-Droplet-User = ctx.userId (the WARP-202 USERNAME the chat session
 * threads through MCP `_meta.userId` — the exact email-tool posture from
 * handlers/email/send.ts). The orchestrator resolves that username
 * against the directory and runs the IDENTICAL participant/module checks
 * a direct human call gets — these helpers only carry the identity, they
 * never widen it.
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

/** The roster row shape GET /api/team-chat/contacts serves. */
export interface RosterContact {
  id: string;
  displayName: string;
  username: string;
}

export type RosterRead =
  | { ok: true; contacts: RosterContact[] }
  | { ok: false; result: ToolResult };

/** Map the roster response. A 404 is the team_chat module gate. */
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
  } | null;
  return { ok: true, contacts: body?.contacts ?? [] };
}

export type RecipientResolution =
  | { ok: true; participantIds: string[] }
  | { ok: false; result: ToolResult };

/**
 * Resolve recipient USERNAMES → local User.ids against the fetched
 * roster. Unknown names fail loudly BEFORE any thread exists. The caller
 * has already deduped and dropped the acting user from `usernames`.
 */
export function pickParticipantIds(
  contacts: RosterContact[],
  usernames: string[],
): RecipientResolution {
  const byUsername = new Map(contacts.map((c) => [c.username, c] as const));
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
  return {
    ok: true,
    participantIds: usernames.map((u) => byUsername.get(u)!.id),
  };
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
