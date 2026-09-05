import type { Request } from "express";

/**
 * WARP-485 -- who an activity row is attributed to.
 *
 * `null` for a missing id AND for the MCP service principal: a tool call has no
 * person behind it, and recording the service id would read as a user in the
 * item's timeline. One implementation for every PM router; `routes/pm/native.ts`
 * and `routes/pm/relations.ts` used to carry byte-identical copies.
 */
export function actorOf(req: Request): string | null {
  const id = req.user?.id;
  if (!id || id === "_service:mcp") return null;
  return id;
}
