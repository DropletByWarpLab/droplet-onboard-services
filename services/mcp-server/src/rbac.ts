import type { Tool, Role } from "@droplet/tools-core";

/**
 * Roles that may call tools flagged `requiresWrite`. Per spec §6.3
 * `owner` and `admin` are the privileged tier; `family` and `guest`
 * are read-only in v1.
 */
const PRIVILEGED: ReadonlySet<Role> = new Set<Role>(["owner", "admin"]);

/**
 * Whether the caller is the trusted in-process principal (stdio
 * transport, the orchestrator agent itself). Pass `true` ONLY from the
 * stdio code path — never derive trust from `role === undefined`,
 * because an HTTP request with a missing role claim is NOT the same
 * thing as a stdio in-proc spawn and must not be granted full access.
 *
 * Defense in depth: even if `verifyJwt` ever stops rejecting unknown
 * role strings, the HTTP transport's `trustedPrincipal: false` argument
 * keeps unknown-role requests from reaching the privileged code path.
 */
export interface RbacOpts {
  trustedPrincipal?: boolean;
}

/**
 * Filter the tool registry by the caller's role.
 *
 * Semantics:
 *   - `trustedPrincipal === true` (stdio in-proc) → all tools.
 *   - privileged role (owner/admin) → all tools.
 *   - any other role (including `undefined` on the HTTP path) → only
 *     tools with `requiresWrite === false`.
 *
 * Accepts any `Iterable<Tool>` so callers can pass `TOOLS.values()`
 * directly without materializing a temp array first.
 */
export function filterToolsForRole(
  tools: Iterable<Tool>,
  role: Role | undefined,
  opts: RbacOpts = {},
): Tool[] {
  if (opts.trustedPrincipal) return [...tools];
  if (role !== undefined && PRIVILEGED.has(role)) return [...tools];
  return [...tools].filter((t) => !t.requiresWrite);
}

/**
 * Re-check on `tools/call` — `tools/list` may have leaked a write tool
 * via cache or an older client, but dispatch must still gate.
 */
export function canCallTool(
  tool: Tool,
  role: Role | undefined,
  opts: RbacOpts = {},
): boolean {
  if (opts.trustedPrincipal) return true;
  if (!tool.requiresWrite) return true;
  return role !== undefined && PRIVILEGED.has(role);
}
