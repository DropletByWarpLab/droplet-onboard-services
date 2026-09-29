/**
 * WARP-3104 — the camera write tools act for owners and admins only, in the
 * tool's own RBAC.
 *
 * The orchestrator already strips every `requiresWrite` tool from a member's
 * chat (narrowAllowedToolsForRole), and the box routes refuse members too.
 * This is the third layer: any dispatch path that reaches a camera write tool
 * with a member, guest or absent role (`ctx.role` is the forwarded caller
 * role; absent means the most-restrictive view) is refused before any HTTP.
 * Settled 2026-09-25: members don't administer cameras, and saving footage
 * is owner/admin custody.
 */
import type { ToolContext, ToolResult } from "../../types.js";

const FORBIDDEN: ToolResult = {
  ok: false,
  status: "error",
  error: { code: "FORBIDDEN", message: "Camera changes can be made by owners and admins only" },
};

/**
 * Call first in the handler body: `const denied = refuseUnlessOwnerOrAdmin(ctx);
 * if (denied) return denied;`. Inline rather than a wrapper so the handler's
 * own body stays inspectable (confirmation-owner-drift.guard reads it).
 */
export function refuseUnlessOwnerOrAdmin(ctx: ToolContext): ToolResult | null {
  return ctx.role === "owner" || ctx.role === "admin" ? null : FORBIDDEN;
}
