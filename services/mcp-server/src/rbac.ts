import { TOOL_CATALOG, type Tool, type Role, type ToolDomain } from "@droplet/tools-core";

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
 * WARP-2979 (ADR-059 P4 §6.13; #2420 review 2a) — tool domains that never
 * leave the box: withheld on every transport that is not the orchestrator's
 * own stdio child (`local-trusted`), whatever the caller's role — an owner's
 * JWT over HTTP (Claude Desktop pointed at a published :9090) included,
 * because that client hands results to its own cloud model. Security events
 * are location and presence data about people.
 *
 * On-box chat keeps every tool: the dashboard's chat, voice and agent runs
 * all go through the orchestrator's agent loop, which spawns this server over
 * stdio (apps/orchestrator/src/services/mcp-client.service.ts). Nothing else
 * on the box is an MCP client (droplet-local-LLM runs no agent: its ADR-003).
 * The orchestrator's own cloud rule for chat turns is OFF_LAN_WITHHELD_DOMAINS
 * (stored-content-egress.service.ts), which lists `security` too.
 */
export const OFF_BOX_WITHHELD_DOMAINS: ReadonlySet<ToolDomain> = new Set<ToolDomain>(["security"]);

const DOMAIN_OF: ReadonlyMap<string, ToolDomain> = new Map(TOOL_CATALOG.map((e) => [e.name, e.domain]));

/** Whether a tool is one of ours in a domain that never leaves the box. A remote server's tool has no domain here. */
export function isWithheldOffBox(tool: Pick<Tool, "name">): boolean {
  const domain = DOMAIN_OF.get(tool.name);
  return domain !== undefined && OFF_BOX_WITHHELD_DOMAINS.has(domain);
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
  // Off the box: never a withheld domain, whatever the role (§6.13).
  const offBox = [...tools].filter((t) => !isWithheldOffBox(t));
  if (role !== undefined && PRIVILEGED.has(role)) return offBox;
  return offBox.filter((t) => !t.requiresWrite);
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
