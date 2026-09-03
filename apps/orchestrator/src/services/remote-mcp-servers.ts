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
import {
  auditRemoteMcpLifecycle,
  remoteMcpLifecycle,
  type RemoteMcpAttachReason,
  type RemoteMcpAttachState,
  type RemoteMcpLifecycleRegistry,
} from "./remote-mcp-lifecycle.service.js";

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
  | "bridge_unavailable"
  /**
   * WARP-2651 — the session opened, and the surface it advertised is not the
   * one we vetted (ADR-043 §1's fourth failure state). The attach is REFUSED
   * rather than completed, so nothing from a changed catalog reaches tool
   * selection until a human re-vets it.
   */
  | "catalog_changed";

export type RemoteAttachResult =
  | {
      attached: true;
      serverId: string;
      sync: RemoteCatalogSyncResult;
      /** What the BRIDGE advertised — the next re-open's drift baseline. */
      vettedTools: readonly string[];
    }
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
  /**
   * WARP-2651 — the catalog a previous attach vetted, handed to the bridge so
   * a RE-open still detects a surface that moved while we were apart.
   *
   * Absent on the boot attach, which is the honest statement: this process has
   * vetted nothing yet, so there is no baseline and the first listing sets one.
   */
  knownTools?: readonly string[];
  /** The lifecycle registry to write transitions into. Injected so a test
   *  drives its own instance; production passes the process-wide one. */
  lifecycle?: RemoteMcpLifecycleRegistry;
  /** Injected so a test asserts the audit rows without a database. */
  auditLifecycle?: typeof auditRemoteMcpLifecycle;
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
  const lifecycle = deps.lifecycle ?? remoteMcpLifecycle;
  const auditLifecycle = deps.auditLifecycle ?? auditRemoteMcpLifecycle;

  /** Write the state and audit only an actual TRANSITION — a tick that found
   *  nothing changed must not append a row, or the channel becomes a heartbeat
   *  nobody reads. */
  const settle = (
    state: RemoteMcpAttachState,
    reason: RemoteMcpAttachReason | null,
    extra: { vettedTools?: readonly string[]; bridgeHop?: "failed" | "succeeded" } = {},
  ): void => {
    const t = lifecycle.record({ serverId, state, reason, ...extra });
    if (t.changed) {
      auditLifecycle({ serverId, event: "transition", from: t.from, to: t.to, reason });
    }
  };

  const gate = await remoteMcpGate(deps.prisma, serverId, deps.allowlist);
  if (!gate.allowed) {
    // `not_allowlisted` is separated from every other refusal because it is the
    // only one that is not a misconfiguration: it is the shipping default.
    const reason: RemoteAttachSkipReason =
      gate.reason === "server_not_allowlisted" ? "not_allowlisted" : "gate_refused";
    logger.info({ serverId, reason: gate.reason }, "remote_mcp_attach_skipped");
    if (reason === "not_allowlisted") {
      // WARP-2651: a box that has not opted in REGISTERS NOTHING. The
      // reconciler's work list is the registry, so an empty registry is what
      // makes "the shipping default dials nothing, ever" a property of the
      // reconciler too and not just of this function. `unregister` rather than
      // "do not record", because an operator who REMOVES a server from the
      // allowlist has to stop it being reconciled on the next boot as well.
      lifecycle.unregister(serverId);
    } else {
      settle("detached", "gate_refused");
    }
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
    settle("detached", "credential_incomplete");
    return {
      attached: false,
      serverId,
      reason: "credential_incomplete",
      message: `The ${serverId} connection holds no credential.`,
    };
  }

  // ADR-042 seam, re-read AT THIS MOMENT and never cached between ticks. The
  // reconciler calls this function on every re-open, so the plaintext credential
  // exists only inside this call: it is opened here, handed to the bridge, and
  // dropped. Holding it across ticks would put a customer's API token in a
  // long-lived orchestrator field for the life of the process, which is exactly
  // what the sealed column and rule 19 exist to prevent — and it would also
  // keep using a credential the operator has since rotated.
  const credential = readAtlassianCredential(
    row,
    deps.openCredentials ?? openSaasCredentials,
  );
  if ("missing" in credential) {
    settle("detached", "credential_incomplete");
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
    await client.open({
      ...credential,
      // Only when we HAVE a baseline. An always-present `knownTools: []` would
      // tell the bridge we vetted an empty surface.
      ...(deps.knownTools && deps.knownTools.length > 0
        ? { knownTools: deps.knownTools }
        : {}),
    });
  } catch (err) {
    logger.warn(
      { serverId, code: err instanceof Error ? err.message : String(err) },
      "remote_mcp_bridge_open_failed",
    );
    // `bridge_unreachable`, not `detached`: the hop that failed is the one to
    // this box's own container, which is a different remedy from anything the
    // operator can fix on the credentials page. It also arms the backoff, so a
    // bridge that is down does not collect a dial every 30 s forever.
    settle("bridge_unreachable", "bridge_unavailable", { bridgeHop: "failed" });
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
    settle("detached", "gate_refused");
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

  // WARP-2651 — the listing above is what makes the bridge compare the server's
  // surface against the baseline we handed it at `open`. Read the session state
  // AFTER it, because `catalog_changed` cannot exist before the first listing
  // and the tools come back 200 either way (ADR-043 §1 forbids rendering drift
  // as an empty list, so the drift arrives as a STATE, not as an error).
  //
  // A changed catalog REFUSES the attach. The alternative — sync it and carry
  // on — is the silent acknowledgement the fourth failure state exists to
  // prevent: an operator classified specific tools under §2, and a surface that
  // moved has to be re-seen rather than absorbed.
  const sessionState = await readSessionState(client, serverId);
  if (sessionState === "catalog_changed") {
    deps.mux.detachRemote(serverId);
    unregisterRemoteServer(serverId, deps.registry);
    // The bridge session is deliberately LEFT OPEN. Closing it would destroy
    // the drift record and the `acknowledge-catalog` call that resolves it,
    // turning "a human must re-vet this" into "it silently came back as new" on
    // the next tick. `ownsBridgeSession` keeps the orphan sweep off it.
    settle("detached", "catalog_changed", { bridgeHop: "succeeded" });
    return {
      attached: false,
      serverId,
      reason: "catalog_changed",
      message:
        `The ${serverId} tool surface changed since it was last reviewed. ` +
        "Nothing from it is advertised until the new catalog is acknowledged.",
    };
  }

  const sync = syncRemoteCatalog(deps.mux, serverId, {
    operatorDomain: ATLASSIAN_OPERATOR_DOMAIN,
    ...(deps.registry ? { registry: deps.registry } : {}),
  });
  const vettedTools = client.lastAdvertisedToolNames();
  settle("attached", null, { vettedTools, bridgeHop: "succeeded" });
  return { attached: true, serverId, sync, vettedTools };
}

/**
 * Read the bridge's session state, treating a failed read as "not drifted".
 *
 * Fail-OPEN here is correct and is not a gate: this read decides only whether
 * to refuse a catalog we already listed successfully. Failing closed would mean
 * a flaky `/state` call could park a healthy integration in `catalog_changed`,
 * which no operator action clears. The real gates — allowlist, the CONNECTED
 * row, the bearer — are all upstream of this line and all still fail closed.
 */
async function readSessionState(
  client: McpBridgeClient,
  serverId: string,
): Promise<string | null> {
  try {
    return (await client.state()).state;
  } catch (err) {
    logger.warn(
      { serverId, code: err instanceof Error ? err.message : String(err) },
      "remote_mcp_state_read_failed",
    );
    return null;
  }
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
