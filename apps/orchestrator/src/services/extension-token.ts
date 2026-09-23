/**
 * WARP-2900 (ADR-056 slice H3): an extension's identity on the box — its
 * call-back bearer's shape, its principal, its multiplexer server id, and
 * the one helper that names it on an audit row — in a module with almost no
 * dependencies of its own.
 *
 * `middleware/auth.ts` resolves a `dxt_` bearer to the `_service:ext:<slug>`
 * principal, and every request on the box passes through it;
 * `mcp-client.service.ts` writes every stdio dispatch's audit row. Importing
 * the lifecycle or attach service into either would pull the sandbox
 * client, the verifier, the bridge client and the tool catalog into their
 * module graphs; these names are all they need. The lifecycle and attach
 * services re-export them, so their surfaces are unchanged.
 */
import { createHash } from "node:crypto";
import { parseNamespacedToolName } from "./mcp-multiplexer.service.js";

/** Every extension bearer starts with this; no other credential does. */
export const EXTENSION_TOKEN_PREFIX = "dxt_";

/** The principal id prefix an extension bearer resolves to. */
export const EXTENSION_PRINCIPAL_PREFIX = "_service:ext:";

/** sha256 hex of the bearer: the only form the database ever holds. */
export function hashExtensionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extensionPrincipalId(slug: string): string {
  return `${EXTENSION_PRINCIPAL_PREFIX}${slug}`;
}

/** Multiplexer server ids of promoted extensions: `ext-<slug>`. */
export const EXTENSION_SERVER_PREFIX = "ext-";

/**
 * The ONE helper for `refs.extensionId` on a `tool_call` row: the extension
 * a call came from (an extension calling back as its owner, carried in the
 * call context) or went to (a namespaced `ext-<slug>__*` tool). `{}` for
 * every other call, so a caller spreads it unconditionally.
 */
export function extensionAuditRefs(
  toolName: string,
  context?: { extensionId?: string },
): { extensionId?: string } {
  if (context?.extensionId) return { extensionId: context.extensionId };
  const serverId = parseNamespacedToolName(toolName)?.serverId;
  if (serverId && serverId.startsWith(EXTENSION_SERVER_PREFIX) && serverId.length > EXTENSION_SERVER_PREFIX.length) {
    return { extensionId: serverId.slice(EXTENSION_SERVER_PREFIX.length) };
  }
  return {};
}
