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
import {
  providerDescriptors,
  type McpProviderDescriptor,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import { TOOLS, type ToolDomain } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";
import {
  recordDiscoveredRemoteTools,
  remoteToolReviewHash,
  type ClassificationPrisma,
} from "./remote-tool-classification.service.js";
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
  type RemoteMcpCredentialKind,
  type RemoteMcpGatePrisma,
} from "./remote-mcp-gateway.service.js";
import {
  createMemberRoutingPort,
  usableConnection,
  type MemberRoutingPrisma,
} from "./mcp-oauth/member-routing.port.js";
import { openTokens } from "./mcp-oauth/mcp-oauth.service.js";
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
  /** WARP-2900 — stamped on every descriptor ({@link RuntimeToolDescriptor.provenance}). */
  provenance?: string;
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
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
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
 * WARP-3703 (ADR-043 TC-1.2) — the OPERATOR's tool domain for each server this
 * process can attach, by server id.
 *
 * Supplied by the OPERATOR side of `resolveRuntimeToolDomain`'s precedence
 * (operator > server > default), because a domain a vendor declared for itself
 * is a hint from outside the box and tool selection is a decision inside it —
 * and because an operator-sourced domain is the only kind a role grant admits a
 * runtime tool through. A server with no entry here is therefore NOT attached
 * ({@link registeredRemoteServers}): it would reach selection under a guessed
 * domain and be unreachable to every role-limited person.
 *
 * Jira and Confluence are project-management surfaces, so Atlassian is `pm`. A
 * new vendor's entry is the one line this map asks of a data PR, and
 * `adr-043-boundary.test.ts` is red until it exists. It lives HERE and not on
 * the provider descriptor because `ToolDomain` is `@droplet/tools-core`'s, and
 * `@droplet/shared-types` — bundled into the dashboard — cannot import it.
 * Frozen, because it decides what a role grant can reach.
 */
export const REMOTE_SERVER_DOMAINS: Readonly<Record<string, ToolDomain>> =
  Object.freeze<Record<string, ToolDomain>>({
    [ATLASSIAN_REMOTE_SERVER_ID]: "pm",
  });

/**
 * The operator domain for a server, or `undefined` for an id the map does not
 * name.
 *
 * An OWN-property read, never a bare index: a server id is `[a-z0-9-]`, which
 * admits `constructor`, and `REMOTE_SERVER_DOMAINS["constructor"]` is a function,
 * not a domain.
 */
export function remoteServerDomain(serverId: string): ToolDomain | undefined {
  return Object.prototype.hasOwnProperty.call(REMOTE_SERVER_DOMAINS, serverId)
    ? REMOTE_SERVER_DOMAINS[serverId]
    : undefined;
}

/**
 * One server this process can attach: the descriptor that says what its
 * credential is, the id it attaches under, and the domain its tools are
 * selected in.
 */
export interface RemoteServerRegistration {
  readonly serverId: string;
  readonly operatorDomain: ToolDomain;
  readonly descriptor: McpProviderDescriptor;
}

/**
 * Every MCP-track provider this build can attach, each paired with its
 * operator domain — what the boot attach loops over and the reconciler's
 * re-open looks a server id up in.
 *
 * A descriptor with no domain is left OUT and reported at error, never attached
 * with a guess: the boundary test makes that a CI failure, and leaving it out
 * keeps a build that slipped past it from taking the other servers down with it.
 *
 * Both parameters default to the shipped registry and are injectable ONLY so a
 * test can hand in a descriptor that exists nowhere else.
 */
export function registeredRemoteServers(
  descriptors: readonly ProviderDescriptor[] = providerDescriptors(),
  domainOf: (serverId: string) => ToolDomain | undefined = remoteServerDomain,
): RemoteServerRegistration[] {
  const registrations: RemoteServerRegistration[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.track !== "mcp") continue;
    const serverId = descriptor.mcpServerId;
    const operatorDomain = domainOf(serverId);
    if (operatorDomain === undefined) {
      logger.error({ serverId }, "remote_mcp_server_has_no_operator_domain");
      continue;
    }
    registrations.push({ serverId, operatorDomain, descriptor });
  }
  return registrations;
}

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
      /** WARP-2659 — the bridge client this attach opened. The multiplexer
       *  holds only the gated port, which has no `close`; this is the one
       *  handle on the bridge session, kept so {@link detachRemoteServer} can
       *  close it rather than merely forget it. */
      client: McpBridgeClient;
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

/**
 * Everything an attach needs that is not about WHICH server it attaches.
 *
 * WARP-3703 — was `AttachAtlassianDeps`, and nothing in it was Atlassian's; the
 * name survives below as an alias for the one wrapper that still carries it.
 */
export interface AttachRemoteDeps {
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
    offLanAllowlistChannel: RemoteMcpGatePrisma["offLanAllowlistChannel"];
    /** WARP-2409 — the sign-in rows. Optional: absent, the API token is the only rung. */
    mcpOAuthConnection?: NonNullable<RemoteMcpGatePrisma["mcpOAuthConnection"]> &
      MemberRoutingPrisma["mcpOAuthConnection"];
    user?: MemberRoutingPrisma["user"];
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
   * WARP-2426 — records every advertised tool as a confirming write (the one
   * import path into `RemoteToolClassification`). Injectable so the attach
   * tests keep their narrow prisma; defaults to the real writer, which needs
   * the wider client in `classificationPrisma`.
   */
  recordClassifications?: (serverId: string, tools: McpToolDescriptor[]) => Promise<unknown>;
  /** The Prisma surface the default `recordClassifications` writes through. */
  classificationPrisma?: ClassificationPrisma;
  /**
   * WARP-3918 — tells every owner and admin a tool was switched off because its
   * definition changed. Absent in narrow tests; production wires
   * `notifyOwnersAndAdmins`.
   */
  notifyOwners?: (title: string, body: string) => Promise<unknown>;
  /**
   * WARP-3918 — publishes the latest listing's per-tool review hashes (wire
   * name → hash) to dispatch, which compares them with the reviewed hash and
   * refuses a mismatch. Called BEFORE any database write, on every listing, so
   * a failed write cannot leave a changed tool callable.
   */
  setLiveDefinitions?: (serverId: string, hashes: ReadonlyMap<string, string>) => void;
  /** WARP-3918 — re-reads the classification cache after a reset, so dispatch
   *  refuses the tool before the notice goes out. */
  refreshClassifications?: () => Promise<unknown>;
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

/** The deps {@link attachAtlassianRemote} takes: everything but the server. */
export type AttachAtlassianDeps = AttachRemoteDeps;

/** The deps {@link attachRemoteServer} takes: the shared ones, and WHICH server. */
export type AttachRemoteServerDeps = AttachRemoteDeps & RemoteServerRegistration;

/**
 * Attach one remote MCP server, if and only if this box is entitled to.
 *
 * WARP-3703 (ADR-043 TC-1.2) — was `attachAtlassianRemote`, whose algorithm was
 * already per server id: the gate, the row read, the bridge, the multiplexer,
 * the drift check and the classification record all keyed on the id and nothing
 * else. What was Atlassian's was a constant, an operator domain and the three
 * facts it read out of the row; those are now the {@link RemoteServerRegistration}
 * this takes.
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
export async function attachRemoteServer(
  deps: AttachRemoteServerDeps,
): Promise<RemoteAttachResult> {
  const { serverId } = deps;
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
  // The gate already proved a usable connection is there; this re-read is the one
  // that returns the material. A row that vanished between the two reads is a
  // `credential_incomplete` skip, not a crash.
  //
  // ADR-042 seam, re-read AT THIS MOMENT and never cached between ticks. The
  // reconciler calls this function on every re-open, so the plaintext credential
  // exists only inside this call: it is opened here, handed to the bridge, and
  // dropped. Holding it across ticks would put a customer's API token in a
  // long-lived orchestrator field for the life of the process, which is exactly
  // what the sealed column and rule 19 exist to prevent - and it would also
  // keep using a credential the operator has since rotated.
  //
  // WARP-2409 - the CATALOG session's credential, in order: the API token, the
  // Workspace connection, the oldest connected member. It is audited on every
  // listing (`refs.credential`). Which sign-in a CALL runs under is decided per
  // call by the member routing port below.
  const apiRead = row?.providerTokensEnc
    ? readRemoteCredential(row, deps.descriptor, deps.openCredentials ?? openSaasCredentials)
    : null;
  let credentialFields: McpBridgeOpenInput;
  let baseCredential: RemoteMcpCredentialKind = "api-token";
  if (apiRead?.ok) {
    credentialFields = apiRead.fields;
  } else {
    const oauth = await catalogOAuthFields(deps, row);
    if (!oauth) {
      settle("detached", "credential_incomplete");
      return {
        attached: false,
        serverId,
        reason: "credential_incomplete",
        // Names the FIELD, never a value.
        message:
          apiRead && !apiRead.ok
            ? `The ${serverId} connection is missing: ${apiRead.missing.join(", ")}.`
            : deps.prisma.mcpOAuthConnection
              ? `An owner or admin must sign in to ${serverId} (or add a Workspace connection or API token) before its tools can be listed.`
              : `The ${serverId} connection holds no credential.`,
      };
    }
    credentialFields = oauth.fields;
    baseCredential = oauth.kind;
  }

  const client = deps.createClient();
  try {
    await client.open({
      ...credentialFields,
      // Only when we HAVE a baseline. An always-present `knownTools: []` would
      // tell the bridge we vetted an empty surface.
      ...(deps.knownTools && deps.knownTools.length > 0
        ? { knownTools: deps.knownTools }
        : {}),
      // WARP-2409 - a personal sign-in backing the catalog never answers calls.
      ...catalogOnlyFor(baseCredential),
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
    // WARP-2409 - with the sign-in models available, each call picks the asking
    // member's own sign-in, then the Workspace's, then the API token. Without
    // them (a narrow test, an old build) the base session is the only rung.
    upstream:
      deps.prisma.user && deps.prisma.mcpOAuthConnection
        ? createMemberRoutingPort({
            serverId,
            client,
            base: client,
            baseCredential,
            prisma: {
              user: deps.prisma.user,
              mcpOAuthConnection: deps.prisma.mcpOAuthConnection,
              integrationConnection: deps.prisma.integrationConnection,
            },
          })
        : client,
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
    operatorDomain: deps.operatorDomain,
    ...(deps.registry ? { registry: deps.registry } : {}),
  });

  // WARP-2426 — every tool the server advertised (the vetted catalog,
  // shadowed names included: a person may want to block one) lands in the
  // classification record as a confirming write, keyed by WIRE name — the
  // multiplexer's catalog carries the NAMESPACED name, and the call policy
  // looks rows up by `(serverId, wireName)`; recording the namespaced form
  // would leave every row unmatchable and every tool "unclassified" forever
  // (the attach test pins the names that cross). The attach does not fail if
  // the record write does: a tool with no row is refused at dispatch as
  // unclassified, so the failure costs capability, never safety — and it is
  // logged at error so it costs it loudly.
  const hashes = client.lastDefinitionHashes();
  // A tool the listing carried no hash for is simply absent here, and dispatch
  // refuses an absent live hash: not pinned never means callable.
  const publishLive = (tools: readonly (McpToolDescriptor & { definitionHash?: string })[]): void =>
    deps.setLiveDefinitions?.(
      serverId,
      new Map(
        tools.flatMap((t) =>
          t.definitionHash ? [[t.name, remoteToolReviewHash(t.description, t.definitionHash)] as const] : [],
        ),
      ),
    );
  publishLive(client.lastListedTools());
  const advertised = deps.mux.remoteCatalog(serverId).map((t) => {
    const name = parseNamespacedToolName(t.name)?.wireName ?? t.name;
    const definitionHash = hashes.get(name);
    return { ...t, name, ...(definitionHash ? { definitionHash } : {}) };
  });
  // WARP-3918 — the definition pin. `definitionHash` is the bridge's sha256 of
  // each tool's whole wire object (annotations included); it rides the
  // existing review-hash path (`inputSchemaHash` → `remoteToolReviewHash`), so
  // a changed definition resets the tool exactly as an `ext-*` one does.
  // `baselineUnpinned`: rows from before the pin adopt their first hash rather
  // than all going dark on upgrade (see the PR description for the choice).
  const record =
    deps.recordClassifications ??
    (deps.classificationPrisma
      ? (id: string, tools: (McpToolDescriptor & { definitionHash?: string })[]) =>
          recordDiscoveredRemoteTools(
            deps.classificationPrisma as ClassificationPrisma,
            id,
            tools.map((t) => ({
              wireName: t.name,
              description: t.description,
              ...(t.definitionHash ? { inputSchemaHash: t.definitionHash } : {}),
            })),
            new Date(),
            { baselineUnpinned: true },
          )
      : undefined);
  /** Record, tell the owners about any tool just switched off, refresh dispatch. */
  const recordAndNotify = async (tools: (McpToolDescriptor & { definitionHash?: string })[]): Promise<void> => {
    if (!record) return;
    const out = (await record(serverId, tools)) as { changes?: { toolName: string; descriptionChanged: boolean }[] } | undefined;
    const changes = out?.changes ?? [];
    if (changes.length === 0) return;
    // Cache first: the tool must be uncallable before anyone is told.
    await deps.refreshClassifications?.();
    await notifyDefinitionChanged(serverId, changes, deps.notifyOwners);
  };
  const seen = new Map<string, string>(hashes);
  if (record) {
    try {
      await recordAndNotify(advertised);
    } catch (err) {
      // The next listing re-records (the live pin already refuses meanwhile).
      seen.clear();
      logger.error({ err, serverId, tools: advertised.length }, "remote_tool_classification_record_failed");
    }
  } else {
    logger.error({ serverId, tools: advertised.length }, "remote_tool_classification_recorder_missing");
  }
  // The bridge listing runs per agent turn. The live hashes are republished on
  // EVERY one (that is the control: dispatch compares them with the reviewed
  // hash, so the pin holds even if everything below fails). A definition that
  // changes mid-session is also recorded and announced on that turn. Cheap
  // when nothing moved: only a differing hash reaches the database.
  let chain: Promise<void> = Promise.resolve();
  // Awaited by the client's listTools, so the cache refresh lands before the
  // listing returns: no turn lists the changed tool and calls it first.
  client.onListed((tools) => {
    publishLive(tools);
    const moved = tools.some((t) => t.definitionHash !== undefined && seen.get(t.name) !== t.definitionHash);
    if (!moved || !record) return chain;
    for (const t of tools) if (t.definitionHash) seen.set(t.name, t.definitionHash);
    chain = chain
      .then(() => recordAndNotify([...tools]))
      .catch((err) => {
        // Forget what was "seen" so the next listing tries again: a failed
        // write must not leave a changed tool looking already handled.
        seen.clear();
        logger.error({ err, serverId }, "remote_tool_definition_recheck_failed");
      });
    return chain;
  });
  const vettedTools = client.lastAdvertisedToolNames();
  // An EMPTY list here is not a vetted surface. `lastAdvertisedToolNames()` is
  // set only by a listing that succeeded, and the multiplexer swallows a
  // failed remote `tools/list` as `REMOTE_CATALOG_UNAVAILABLE` rather than
  // failing the attach — so this attach can complete with nothing listed.
  // Recording `[]` then would overwrite the baseline a previous attach DID
  // vet, and the next re-open would carry no `knownTools`: drift detection
  // silently off for exactly one re-open, which is all the window a moved
  // surface needs. Omitting the field keeps the stored baseline (`record()`
  // keeps the previous value when none is given) — the same rule the open
  // path applies by refusing to send `[]` as a baseline.
  settle("attached", null, {
    ...(vettedTools.length > 0 ? { vettedTools } : {}),
    bridgeHop: "succeeded",
  });
  return { attached: true, serverId, sync, client, vettedTools };
}

/**
 * WARP-3918 — the owners' and admins' notice that tools were switched off
 * because the server changed their definition. Names the tool and the kind of
 * change; never quotes the new description (server-supplied text, and the thing
 * the review is for). Tool names are server-supplied too: bounded.
 */
export async function notifyDefinitionChanged(
  serverId: string,
  changes: readonly { toolName: string; descriptionChanged: boolean }[],
  notifyOwners?: (title: string, body: string) => Promise<unknown>,
): Promise<void> {
  logger.warn({ serverId, tools: changes.map((c) => c.toolName) }, "remote_tool_definition_changed");
  if (!notifyOwners) return;
  const shown = changes.slice(0, 5).map((c) => `${c.toolName.slice(0, 64)} (${c.descriptionChanged ? "description" : "arguments or hints"} changed)`);
  const more = changes.length > shown.length ? ` and ${changes.length - shown.length} more` : "";
  try {
    await notifyOwners(
      "A connected tool changed and was switched off",
      `${serverId} changed ${shown.join(", ")}${more} since an owner last reviewed it. ` +
        "The tool is switched off until it is reviewed again.",
    );
  } catch (err) {
    logger.error({ err, serverId }, "remote_tool_definition_notice_failed");
  }
}

/**
 * Attach the Atlassian remote — {@link attachRemoteServer} with Atlassian's
 * registration. Kept as the one name the Atlassian suites and the first
 * integration read.
 */
export async function attachAtlassianRemote(
  deps: AttachAtlassianDeps,
): Promise<RemoteAttachResult> {
  const registration = registeredRemoteServers().find(
    (s) => s.serverId === ATLASSIAN_REMOTE_SERVER_ID,
  );
  if (!registration) {
    throw new Error("the atlassian provider descriptor or its operator domain is not registered");
  }
  return attachRemoteServer({ ...deps, ...registration });
}

export interface DetachRemoteDeps {
  mux: McpToolMultiplexer;
  serverId: string;
  /** The bridge client {@link attachRemoteServer} opened, if this process
   *  holds one. Absent when nothing attached — the in-process half of the
   *  detach still runs, and is still worth running. */
  client?: { close(): Promise<void> };
  registry?: RemoteCatalogSyncOptions["registry"];
}

export interface DetachRemoteResult {
  serverId: string;
  /** Whether the multiplexer had this server attached. */
  detached: boolean;
  /** Whether a bridge session was told to close. `false` only when no client
   *  was held; a bridge that could not be reached still counts as told, and
   *  the client marks itself closed either way. */
  sessionClosed: boolean;
}

/**
 * WARP-2659 — the disconnect half of {@link attachRemoteServer}.
 *
 * Three things hold state after an attach, and the credential purge in
 * `integrations.service.ts` `disconnect()` reaches none of them: the bridge
 * session (`services/mcp-bridge`, holding the token in memory), the
 * multiplexer entry that routes `<serverId>__*` calls to it, and the runtime
 * tools `syncRemoteCatalog` published into selection. The per-call gate
 * already refuses egress the moment the row leaves CONNECTED — that is why it
 * is a function — but a refused call is still a call the model was allowed to
 * choose, and a bridge session still holds a credential the box just said it
 * removed. ADR-043 §4's rule for the kill switch applies here for the same
 * reason: tear down, do not merely decline to re-establish.
 *
 * Bridge first, so that if this process dies mid-way the vendor-facing half is
 * the one that went. Every step is idempotent, and a `close()` the bridge
 * refuses is swallowed the way the attach path swallows it — the client marks
 * itself closed regardless, and the two in-process steps must still run.
 */
export async function detachRemoteServer(deps: DetachRemoteDeps): Promise<DetachRemoteResult> {
  const { serverId } = deps;
  let sessionClosed = false;
  if (deps.client) {
    await deps.client.close().catch((err: unknown) => {
      logger.warn(
        { serverId, code: err instanceof Error ? err.message : String(err) },
        "remote_mcp_bridge_close_failed",
      );
    });
    sessionClosed = true;
  }
  const detached = deps.mux.detachRemote(serverId);
  unregisterRemoteServer(serverId, deps.registry);
  logger.info({ serverId, detached, sessionClosed }, "remote_mcp_server_detached_for_disconnect");
  return { serverId, detached, sessionClosed };
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

/** What a connection row yielded: the fields to open a session with, or the
 *  NAMES of the ones it lacked. Tagged rather than discriminated by a key,
 *  because the fields are an open record and any key could be one of them. */
type RemoteCredentialRead =
  | { ok: true; fields: McpBridgeOpenInput }
  | { ok: false; missing: string[] };

/** `catalogOnly` for a base session backed by a personal (owner/admin member) sign-in, else nothing. */
export function catalogOnlyFor(kind: RemoteMcpCredentialKind): { catalogOnly: true } | Record<string, never> {
  return kind === "member" ? { catalogOnly: true } : {};
}

/**
 * WARP-2409 - the catalog session's sign-in credential when there is no usable
 * API token: the Workspace connection first, else the oldest connected member.
 * The bridge's bearer profile takes `{ accessToken, cloudId }`; the site id is
 * the one the admin entered on the connection (never from the model).
 */
export async function catalogOAuthFields(
  deps: AttachRemoteServerDeps,
  row: RemoteMcpConnectionRow | null,
): Promise<{ fields: Record<string, string>; kind: RemoteMcpCredentialKind } | null> {
  const table = deps.prisma.mcpOAuthConnection;
  const site = (row?.providerConfig as Record<string, unknown> | null | undefined)?.cloudId;
  if (!table || typeof site !== "string" || !site.trim()) return null;
  const candidates = [
    await table.findFirst({ where: { provider: deps.serverId, scope: "WORKSPACE", state: "CONNECTED" } }),
    // A regular member's token backs ONLY that member's own calls. The shared
    // catalog session may use a member's sign-in only if that person is an owner
    // or admin RIGHT NOW (they approve servers and review their tools): the role
    // is joined and checked at attach time, so a demotion or deactivation stops
    // the next attach from picking them.
    await table.findFirst({
      where: {
        provider: deps.serverId,
        scope: "MEMBER",
        state: "CONNECTED",
        member: { is: { role: { in: ["owner", "admin"] }, directoryStatus: "ACTIVE", deletionStatus: "NONE" } },
      },
      orderBy: { connectedAt: "asc" },
    }),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const live = await usableConnection({ mcpOAuthConnection: table }, candidate);
    if (!live) continue;
    try {
      return {
        fields: { accessToken: openTokens(live).accessToken, cloudId: site.trim() },
        kind: live.scope === "WORKSPACE" ? "workspace" : "member",
      };
    } catch {
      // A blob that does not open under its own row is not a credential.
      logger.warn({ serverId: deps.serverId }, "remote_mcp_oauth_tokens_unreadable");
    }
  }
  return null;
}

/**
 * Pull the facts a session needs out of one connection row, as the descriptor
 * says they are stored.
 *
 * WARP-3703 — was `readAtlassianCredential`, which read exactly `email`,
 * `cloudId` and `apiToken`. The facts are now the descriptor's own REQUIRED
 * `credentialFields`, and ADR-042 §5 still decides where each lives: a field
 * with `storage: "encrypted"` comes out of the sealed `providerTokensEnc`
 * bundle, one with `storage: "providerConfig"` out of `providerConfig`. This
 * reads exactly one home per fact rather than accepting either: a fallback
 * between the two would mean a credential could sit in the unencrypted column
 * and still work, which is how it would end up there. A required field stored
 * anywhere else is counted as missing, by name, not skipped.
 *
 * An OPTIONAL field is never forwarded. Atlassian's `tokenExpiresAt` is a fact
 * ABOUT the credential, not an input to the session, and sending it would hand
 * the bridge a customer fact it did not ask for.
 *
 * A non-secret fact is trimmed and a secret is used verbatim. A missing field is
 * reported by NAME, never by value, facts first and then secrets — the order the
 * Atlassian-only reader reported a half-filled row in, kept so its message does
 * not change.
 */
function readRemoteCredential(
  row: RemoteMcpConnectionRow,
  descriptor: McpProviderDescriptor,
  open: (connectionId: string, blob: string) => Record<string, string>,
): RemoteCredentialRead {
  const required = descriptor.credentialFields.filter((f) => f.required);
  const sealed = required.filter((f) => f.storage === "encrypted");
  let secrets: Record<string, string> = {};
  try {
    secrets = open(row.id, row.providerTokensEnc ?? "");
  } catch {
    // A bundle sealed for another row fails GCM's tag check. Reported as a
    // missing credential — never as an empty one, which would send the box to
    // the vendor with no auth and collect an opaque 401.
    return {
      ok: false,
      missing: [`${sealed.map((f) => f.name).join(", ")} (sealed credential could not be opened)`],
    };
  }
  const config =
    typeof row.providerConfig === "object" && row.providerConfig !== null
      ? (row.providerConfig as Record<string, unknown>)
      : {};

  const fields: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of [...required.filter((f) => f.storage !== "encrypted"), ...sealed]) {
    const raw =
      field.storage === "encrypted"
        ? secrets[field.name]
        : field.storage === "providerConfig"
          ? config[field.name]
          : undefined;
    const value =
      typeof raw !== "string" ? "" : field.storage === "providerConfig" ? raw.trim() : raw;
    if (value) fields[field.name] = value;
    else missing.push(field.name);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, fields };
}
