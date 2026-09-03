/**
 * WARP-2418 — the ONE client-side seam through which a runtime-discovered
 * tool becomes visible to tool selection, and the operator allowlist that
 * gates it.
 *
 * ## What "teach TOOLS / TOOL_CATALOG / TOOL_ROUTES about runtime tools" means
 *
 * It means the opposite of writing into them, and the distinction is the whole
 * design:
 *
 *   - **`TOOLS`** (`packages/tools-core/src/registry.ts`) is a frozen literal
 *     array of handlers compiled into the box. A remote tool has no handler of
 *     ours (ADR-043 §3), so it has nothing to put there. "Destructive actions
 *     are blocked" is implemented BY absence from that array
 *     (`__tests__/storage-pool-tools.test.ts`); injecting wire-sourced entries
 *     would make that guarantee mean something weaker without anyone editing
 *     the test that states it.
 *   - **`TOOL_CATALOG` / `DOMAIN_GROUPS`** are derived from `TOOLS` and
 *     CI-gated for completeness (`catalog.test.ts`). The catalog answers "what
 *     is installed on this box" for the dashboard `/tools` surface; a session
 *     to a vendor's server is not an installed capability, and a catalog that
 *     said so would be lying to the operator.
 *   - **`TOOL_ROUTES`** declares which orchestrator route each handler dials,
 *     so the admission suite can prove the `_service:mcp` principal reaches
 *     it. A remote tool dials no route of ours. A row would be a fiction the
 *     cross-check would then have to be taught to skip.
 *
 * So the seam is a PARALLEL layer: `runtime-tool-registry.service.ts` holds
 * the descriptors, `tool-selection.service.ts` reads both layers with the
 * static one winning, and this module is the only thing that writes to it.
 * `runtime-tool-registry.service.ts`'s own header carries the matching
 * rationale — this file is the writer it says WARP-2300 would bring.
 *
 * ## The allowlist ships EMPTY, and that is a budget decision as well as a
 * safety one
 *
 * ADR-043's Consequences are explicit: the context window is already
 * over-subscribed, the full local registry no longer fits `OLLAMA_CONTEXT_LENGTH`
 * at all, and per-turn selection (WARP-2348) gates any remote catalog reaching
 * default chat. Advertising a 50-tool Atlassian catalog on a box that has not
 * opted in makes the assistant worse at everything else it does. So
 * {@link parseRemoteMcpAllowlist} of an unset variable is the empty set, an
 * empty set allows no server, and nothing remote is advertised until an
 * operator names a server id.
 */
import { TOOLS, type ToolDomain } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";
import {
  parseNamespacedToolName,
  type McpToolMultiplexer,
  type RemoteRejection,
} from "./mcp-multiplexer.service.js";
import {
  resolveRuntimeToolDomain,
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
  type RuntimeToolRegistry,
} from "./runtime-tool-registry.service.js";
import type { McpBridgeClient, McpBridgeOpenInput } from "./mcp-bridge.client.js";
import {
  createGatedRemoteMcpPort,
  remoteMcpGate,
  type RemoteMcpGatePrisma,
} from "./remote-mcp-gateway.service.js";
import { openSaasCredentials } from "./saas-credential.service.js";

const logger = createLogger("remote-mcp-servers");

/**
 * The operator's allowlist of remote MCP server ids.
 *
 * Comma-separated, whitespace-tolerant, case-normalised to lowercase (server
 * ids are lowercase by {@link McpToolMultiplexer}'s own pattern, so an
 * operator typing `Atlassian` gets the server they meant rather than a silent
 * miss).
 */
export const REMOTE_MCP_ALLOWLIST_ENV = "REMOTE_MCP_SERVER_ALLOWLIST";

/** Parse the allowlist. An unset / blank / all-separators value is EMPTY. */
export function parseRemoteMcpAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** Every tool name compiled into this box. The set a remote tool may not
 *  shadow — read off the live registry so it can never be a stale copy. */
export function localToolNames(): ReadonlySet<string> {
  return new Set(TOOLS.keys());
}

export interface RemoteCatalogSyncOptions {
  /** Operator-configured domain for this server. Wins over `serverDomain`. */
  operatorDomain?: ToolDomain;
  /** Domain the server declared for itself. A hint from outside the box. */
  serverDomain?: ToolDomain;
  /** Injectable for tests; defaults to the process-wide registry. */
  registry?: RuntimeToolRegistry;
}

export interface RemoteCatalogSyncResult {
  serverId: string;
  registered: RuntimeToolDescriptor[];
  /** Everything the multiplexer or this seam refused, so a caller can render
   *  "3 of 50 tools were not registered, and why" rather than a count. */
  rejected: readonly RemoteRejection[];
}

/**
 * Read one attached server's vetted catalog out of the multiplexer and
 * publish it to the runtime tool registry.
 *
 * The multiplexer has already namespaced the names and dropped collisions;
 * this adds the one thing selection needs and a wire catalog cannot supply —
 * a domain — and re-checks the local-shadowing rule at the registry boundary.
 * That re-check is not redundant: the two layers are written to be
 * independently sufficient, so removing either one has to turn a test red
 * (WARP-2420).
 */
export function syncRemoteCatalog(
  mux: McpToolMultiplexer,
  serverId: string,
  opts: RemoteCatalogSyncOptions = {},
): RemoteCatalogSyncResult {
  const registry = opts.registry ?? runtimeToolRegistry;
  const locals = localToolNames();
  const rejected: RemoteRejection[] = [];
  const registered: RuntimeToolDescriptor[] = [];

  for (const tool of mux.remoteCatalog(serverId)) {
    if (locals.has(tool.name)) {
      // Defence in depth for WARP-2420: the multiplexer refuses this too, but
      // a registry that trusted its caller would be one refactor away from
      // letting a wire-sourced name take a local tool's selection slot.
      rejected.push({
        code: "SHADOWS_LOCAL_TOOL",
        serverId,
        toolName: tool.name,
        message: `"${tool.name}" is a registered local tool; refusing to register it as remote.`,
      });
      continue;
    }
    registered.push(toRuntimeDescriptor(serverId, tool, opts));
  }

  registry.registerServerTools(serverId, registered);
  logger.info(
    { serverId, registered: registered.length, rejected: rejected.length },
    "remote_catalog_synced",
  );
  return { serverId, registered, rejected: [...rejected, ...mux.rejections()] };
}

/** Drop a server's runtime tools — the disconnect / allowlist-removal path. */
export function unregisterRemoteServer(
  serverId: string,
  registry: RuntimeToolRegistry = runtimeToolRegistry,
): void {
  registry.unregisterServer(serverId);
}

function toRuntimeDescriptor(
  serverId: string,
  tool: McpToolDescriptor,
  opts: RemoteCatalogSyncOptions,
): RuntimeToolDescriptor {
  const { domain, source } = resolveRuntimeToolDomain({
    toolName: tool.name,
    serverId,
    operatorDomain: opts.operatorDomain,
    serverDomain: opts.serverDomain,
  });
  return {
    name: tool.name,
    serverId,
    domain,
    domainSource: source,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
  };
}

/**
 * The namespaced-name reader the rest of the orchestrator should use to ask
 * "is this a remote tool, and whose?" — so nothing else re-derives the
 * separator convention.
 */
export function remoteServerIdOf(toolName: string): string | null {
  return parseNamespacedToolName(toolName)?.serverId ?? null;
}

// --- WARP-2627: attaching a server for real ---------------------------------

/**
 * The Atlassian server id, as THIS process names it.
 *
 * Declared here rather than imported from `@droplet/mcp-bridge`: importing that
 * package's barrel would pull `StreamableHTTPClientTransport` into the
 * orchestrator's module graph, which ADR-043 §5 names as the breach a reviewer
 * looks for. The duplication is deliberate and it is GATED — `adr-043-boundary.test.ts`
 * reads the bridge's own source and fails if the two literals diverge, and a
 * divergence that slipped past it would surface as the bridge's explicit
 * `UNKNOWN_SERVER_ID` rather than as an empty tool list.
 */
export const ATLASSIAN_REMOTE_SERVER_ID = "atlassian";

/**
 * Operator domain for Atlassian's catalog.
 *
 * Jira and Confluence are project-management surfaces, so `pm` — supplied by
 * the OPERATOR side of `resolveRuntimeToolDomain`'s precedence (operator >
 * server > default), because a domain a vendor declared for itself is a hint
 * from outside the box and tool selection is a decision inside it.
 */
const ATLASSIAN_OPERATOR_DOMAIN: ToolDomain = "pm";

/** Why an attach did not happen. Every value is a different thing for an
 *  operator to do, and none of them is an error. */
export type RemoteAttachSkipReason =
  | "not_allowlisted"
  | "gate_refused"
  | "credential_incomplete"
  | "bridge_unavailable";

export type RemoteAttachResult =
  | { attached: true; serverId: string; sync: RemoteCatalogSyncResult }
  | { attached: false; serverId: string; reason: RemoteAttachSkipReason; message: string };

/** The row columns the attach path reads. Structural, so a test passes a
 *  literal instead of standing up Prisma. */
export interface RemoteMcpConnectionRow {
  id: string;
  status: string;
  providerTokensEnc: string | null;
  providerConfig: unknown;
}

export interface AttachAtlassianDeps {
  mux: McpToolMultiplexer;
  /**
   * Reads the gate AND the credential — one narrow surface, injected.
   *
   * The row shape is the WIDER of the two (it carries `providerConfig`), which
   * is assignable to {@link RemoteMcpGatePrisma}'s narrower one, so the same
   * client serves both reads without a second declaration to keep in step.
   */
  prisma: {
    integrationConnection: {
      findFirst(args: unknown): Promise<RemoteMcpConnectionRow | null>;
    };
  };
  allowlist: ReadonlySet<string>;
  /** Builds the bridge-backed port. Injected so a test supplies a fixture
   *  bridge and can assert it was never dialled. */
  createClient: () => McpBridgeClient;
  /** Injected purely so the credential-opening step is testable without the
   *  process-wide column-crypto key. */
  openCredentials?: (connectionId: string, blob: string) => Record<string, string>;
  registry?: RemoteCatalogSyncOptions["registry"];
}

/**
 * Attach the Atlassian remote, if and only if this box is entitled to.
 *
 * ORDER IS THE POINT, and it is the same order `routes/web.ts` states: the
 * cheapest, most certain refusal first, and NOTHING is dialled until every one
 * of them has passed.
 *
 *   1. allowlist — a box that has not opted in never constructs a client, so
 *      the bridge is not even reached to be told "no";
 *   2. the connection row's explicit `status` + credential columns;
 *   3. the credential's own completeness;
 *   4. only then: open a session on the bridge.
 *
 * Returns rather than throws for every skip. None of these is an error — an
 * un-opted-in box is the DEFAULT box — and a throw here would put a stack trace
 * in the boot log of every appliance in the fleet.
 */
export async function attachAtlassianRemote(
  deps: AttachAtlassianDeps,
): Promise<RemoteAttachResult> {
  const serverId = ATLASSIAN_REMOTE_SERVER_ID;
  const gate = await remoteMcpGate(deps.prisma, serverId, deps.allowlist);
  if (!gate.allowed) {
    // `not_allowlisted` is separated from every other refusal because it is the
    // only one that is not a misconfiguration: it is the shipping default.
    const reason: RemoteAttachSkipReason =
      gate.reason === "server_not_allowlisted" ? "not_allowlisted" : "gate_refused";
    logger.info({ serverId, reason: gate.reason }, "remote_mcp_attach_skipped");
    return { attached: false, serverId, reason, message: gate.message };
  }

  const row = await deps.prisma.integrationConnection.findFirst({
    where: { provider: serverId },
    select: { id: true, status: true, providerTokensEnc: true, providerConfig: true },
  });
  // The gate already proved the row and its credential column are there; this
  // re-read is the one that returns the material. A row that vanished between
  // the two reads is a `credential_incomplete` skip, not a crash.
  if (!row?.providerTokensEnc) {
    return {
      attached: false,
      serverId,
      reason: "credential_incomplete",
      message: `The ${serverId} connection holds no credential.`,
    };
  }

  const credential = readAtlassianCredential(
    row,
    deps.openCredentials ?? openSaasCredentials,
  );
  if ("missing" in credential) {
    return {
      attached: false,
      serverId,
      reason: "credential_incomplete",
      // Names the FIELD, never a value.
      message: `The ${serverId} connection is missing: ${credential.missing.join(", ")}.`,
    };
  }

  const client = deps.createClient();
  try {
    await client.open(credential);
  } catch (err) {
    logger.warn(
      { serverId, code: err instanceof Error ? err.message : String(err) },
      "remote_mcp_bridge_open_failed",
    );
    return {
      attached: false,
      serverId,
      reason: "bridge_unavailable",
      message: `Could not open a session on mcp-bridge for ${serverId}.`,
    };
  }

  const gated = createGatedRemoteMcpPort({
    serverId,
    upstream: client,
    // Re-read on EVERY call, not captured once here: an operator who
    // disconnects the account mid-session must stop reaching the vendor on the
    // next call, not on the next reboot.
    gate: () => remoteMcpGate(deps.prisma, serverId, deps.allowlist),
  });

  const rejection = deps.mux.attachRemote(serverId, gated);
  if (rejection) {
    await client.close().catch(() => undefined);
    return {
      attached: false,
      serverId,
      reason: "gate_refused",
      message: rejection.message,
    };
  }

  // The multiplexer's catalog is populated by `listTools()`, and
  // `syncRemoteCatalog` reads it — so the listing has to happen first or the
  // sync publishes an empty catalog and the tools never reach selection.
  await deps.mux.listTools();
  const sync = syncRemoteCatalog(deps.mux, serverId, {
    operatorDomain: ATLASSIAN_OPERATOR_DOMAIN,
    ...(deps.registry ? { registry: deps.registry } : {}),
  });
  return { attached: true, serverId, sync };
}

/**
 * Pull the three facts a session needs out of one connection row.
 *
 * ADR-042 §5 decides where each lives, and this reads exactly one home per
 * fact rather than accepting either: the secret (`apiToken`) comes out of the
 * sealed `providerTokensEnc` bundle, the two non-secret connection facts
 * (`email`, `cloudId`) out of `providerConfig`. A fallback between the two
 * homes would mean a credential could sit in the unencrypted column and still
 * work, which is how it would end up there.
 */
function readAtlassianCredential(
  row: RemoteMcpConnectionRow,
  open: (connectionId: string, blob: string) => Record<string, string>,
): McpBridgeOpenInput | { missing: string[] } {
  let secrets: Record<string, string> = {};
  try {
    secrets = open(row.id, row.providerTokensEnc ?? "");
  } catch {
    // A bundle sealed for another row fails GCM's tag check. Reported as a
    // missing credential — never as an empty one, which would send the box to
    // the vendor with no auth and collect an opaque 401.
    return { missing: ["apiToken (sealed credential could not be opened)"] };
  }
  const config =
    typeof row.providerConfig === "object" && row.providerConfig !== null
      ? (row.providerConfig as Record<string, unknown>)
      : {};
  const email = typeof config.email === "string" ? config.email.trim() : "";
  const cloudId = typeof config.cloudId === "string" ? config.cloudId.trim() : "";
  const apiToken = typeof secrets.apiToken === "string" ? secrets.apiToken : "";

  const missing = [
    email ? null : "email",
    cloudId ? null : "cloudId",
    apiToken ? null : "apiToken",
  ].filter((f): f is string => f !== null);
  if (missing.length > 0) return { missing };
  return { email, apiToken, cloudId };
}
