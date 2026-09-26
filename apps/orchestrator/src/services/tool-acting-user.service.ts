/**
 * WARP-3101 — whose rows a request is about, when the caller may be one of the
 * assistant's tools.
 *
 * Calendar events and reminders are keyed on the person's USERNAME
 * (`CalendarEvent.userId` / `Reminder.userId`). A person in the browser acts
 * for themselves: `req.user.username`.
 *
 * The assistant's tools arrive as the `_service:mcp` principal, whose own
 * username is nobody's: reading on it finds no rows, and writing on it files a
 * row nobody sees. The person the tool acts for is asserted in
 * `X-Nextcloud-User` (mcp-server context.ts `withActingUser`), trusted only
 * from that principal. It holds `User.username` on the stdio transport and
 * `User.id` on the HTTP one, so it is resolved by `resolveAssertedUser`
 * (username, nextcloudUsername or id; nobody, ambiguous or deactivated is
 * denied), and the row key is the resolved person's username — never the
 * header value itself, which is a `User.id` half the time.
 *
 * Then the question chat asks before it dispatches the tool, asked of the same
 * person off their User row (`resolveAttributedToolAccess`): may their tier
 * (the ADR-004 write filter) and their access role (ADR-032 §3) use it? A
 * route that serves several tools cannot tell which one called it —
 * `POST /reminders` is both `create_reminder` and `set_timer` — so the person
 * must be allowed EVERY tool the route serves: the narrower answer, never the
 * wider.
 *
 * Nobody named, nobody found, ambiguous, deactivated or unreadable → denied
 * `acting_user_required`; a refusal → `forbidden_tool_for_role`. Never the
 * service principal, never a wider identity.
 */
import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { resolveAttributedToolAccess, toolAllowedForPrincipal } from "./tool-access.service.js";
import { MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";

/** A route's tools: the ones whose handlers call it (tools-core TOOL_ROUTES). */
export type RouteTools = readonly [string, ...string[]];

export type ToolActingUser =
  | { ok: true; username: string }
  | { ok: false; denied: "acting_user_required" }
  | { ok: false; denied: "forbidden_tool_for_role"; tool: string };

export async function toolActingUser(
  prisma: PrismaClient,
  req: Request,
  tools: RouteTools,
): Promise<ToolActingUser> {
  if (!(req.user?.id === MCP_PRINCIPAL_ID && req.user.role === "service")) {
    const username = req.user?.username;
    // authMiddleware guarantees req.user on these routes; an absent username is
    // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
    if (!username) throw new Error("authenticated user required");
    return { ok: true, username };
  }
  const asserted = (req.header("x-nextcloud-user") ?? "").trim();
  if (!asserted) return { ok: false, denied: "acting_user_required" };
  const resolved = await resolveAssertedUser(prisma, asserted);
  if (!resolved.ok) return { ok: false, denied: "acting_user_required" };
  const access = await resolveAttributedToolAccess(prisma, resolved.user.id);
  if (access.unresolved) return { ok: false, denied: "acting_user_required" };
  const refused = tools.find((tool) => !toolAllowedForPrincipal(tool, access.tier ?? undefined, access.scope));
  if (refused !== undefined) return { ok: false, denied: "forbidden_tool_for_role", tool: refused };
  return { ok: true, username: resolved.user.username };
}

/** The 403 for a denial, in the shape POST /notifications/send answers with. */
export function sendToolActingUserDenial(res: Response, denial: Exclude<ToolActingUser, { ok: true }>): void {
  res
    .status(403)
    .json(denial.denied === "forbidden_tool_for_role" ? { error: denial.denied, tool: denial.tool } : { error: denial.denied });
}
