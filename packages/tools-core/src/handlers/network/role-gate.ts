/**
 * WARP-3632 — the network read tools check the caller's role themselves.
 *
 * The orchestrator's network routes floor their reads with
 * `requireNetworkMember` (owner/admin/member) or `requireRole("owner","admin")`,
 * but a tool call reaches them as the `_service:mcp` principal, which those
 * guards admit before any role check — and two tools (`list_network_devices`,
 * `list_ap_devices`) read Prisma with no route at all. So the route floor says
 * nothing about the person in the chat: THIS check is the only one that sees
 * them (`ctx.role` is the forwarded caller role; absent means the most
 * restrictive view). Keep each tool's floor equal to its route's floor;
 * `apps/orchestrator/src/__tests__/network-read-floor.parity.test.ts` fails
 * when they drift.
 *
 * Call first in the handler body:
 * `const denied = refuseBelowNetworkMember(ctx); if (denied) return denied;`
 */
import type { ToolContext, ToolResult } from "../../types.js";

const forbidden = (message: string): ToolResult => ({
  ok: false,
  status: "error",
  error: { code: "FORBIDDEN", message },
});

/** Owner, admin, member (`family`) and the internal `service` principal; never a guest. */
export function refuseBelowNetworkMember(ctx: ToolContext): ToolResult | null {
  const r = ctx.role;
  return r === "owner" || r === "admin" || r === "family" || r === "service"
    ? null
    : forbidden("Network configuration is visible to members, admins and owners only");
}

/** Owner and admin only. */
export function refuseUnlessNetworkAdmin(ctx: ToolContext): ToolResult | null {
  return ctx.role === "owner" || ctx.role === "admin"
    ? null
    : forbidden("This network setting is visible to owners and admins only");
}
