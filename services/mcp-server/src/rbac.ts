import type { Tool, Role } from "@droplet/tools-core";

/**
 * Roles that may call tools flagged `requiresWrite`. Per spec §6.3
 * `owner` and `admin` are the privileged tier; `family` and `guest`
 * are read-only in v1.
 */
const PRIVILEGED: ReadonlySet<Role> = new Set<Role>(["owner", "admin"]);

/**
 * Filter the tool registry by the caller's role.
 *
 * Semantics:
 *   - `role === undefined` (stdio in-proc, fully trusted) → all tools.
 *   - privileged role (owner/admin) → all tools.
 *   - any other role → only tools with `requiresWrite === false`.
 *
 * Accepts any `Iterable<Tool>` so callers can pass `TOOLS.values()`
 * directly without materializing a temp array first.
 */
export function filterToolsForRole(tools: Iterable<Tool>, role: Role | undefined): Tool[] {
  if (role === undefined || PRIVILEGED.has(role)) return [...tools];
  return [...tools].filter((t) => !t.requiresWrite);
}

/**
 * Re-check on `tools/call` — `tools/list` may have leaked a write tool
 * via cache or an older client, but dispatch must still gate.
 */
export function canCallTool(tool: Tool, role: Role | undefined): boolean {
  if (role === undefined) return true;
  if (!tool.requiresWrite) return true;
  return PRIVILEGED.has(role);
}
