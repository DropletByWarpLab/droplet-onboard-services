/**
 * Process-wide MCP client singleton.
 *
 * One stdio child process per orchestrator process. Booted lazily during
 * Express startup (`ensureMcpStarted` from `index.ts`) and stopped on
 * SIGTERM/SIGINT. The agent loop in `/api/llm/chat` and any future
 * MCP-aware route just imports `mcpClient` and calls `listTools()` /
 * `callTool()`; the heavy lifting lives in `McpClientService`.
 *
 * WARP-2395 — `mcpClient` is now an `McpToolMultiplexer` wrapping that child
 * rather than the child itself. The child is still the only session a
 * shipping box has (the remote allowlist is empty), and the exported name,
 * type surface and behaviour are unchanged for every importer.
 *
 * The path resolution prefers an explicit `MCP_SERVER_BIN` env var (set
 * by Docker / dev scripts) and falls back to the workspace-relative
 * `services/mcp-server/dist/index.js`. The fallback uses `process.cwd()`
 * because the orchestrator's `package.json` does not set
 * `"type": "module"`, so `import.meta.url` would trip tsc.
 */
import path from "node:path";
import { defaultToolCallInterceptor } from "@droplet/tools-core";
import { config } from "../config.js";
import { recordActivity } from "./activity.singleton.js";
import { confirmationActivityParams } from "./confirmation-audit.js";
import { createLogger } from "../lib/logger.js";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { abortRemoteMcpInFlight } from "./remote-mcp-gateway.service.js";
import { McpClientService } from "./mcp-client.service.js";
import { McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import {
  composeRemoteCallPolicy,
  createRecordBackedRemoteCallPolicy,
  remoteToolClassificationCache,
} from "./remote-tool-classification.service.js";
import { remoteToolTablePolicy } from "./remote-tool-tables.js";
import type { RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import { installedExtensionIds } from "./extension-lifecycle.service.js";
import { EXTENSION_SERVER_PREFIX } from "./extension-token.js";
import {
  attachRemoteServer,
  detachRemoteServer,
  parseRemoteMcpAllowlist,
  registeredRemoteServers,
  type AttachRemoteDeps,
  type RemoteAttachResult,
  type RemoteServerRegistration,
} from "./remote-mcp-servers.js";
import type { RemoteMcpReconcilerDeps } from "./remote-mcp-reconciler.service.js";

const logger = createLogger("mcp-client-singleton");

const SERVER_BIN =
  process.env.MCP_SERVER_BIN ??
  path.resolve(process.cwd(), "../../services/mcp-server/dist/index.js");

/** The one stdio child. Still the only thing that exists on a shipping box —
 *  see {@link mcpClient} for why it is no longer what callers hold. */
const localClient = new McpClientService({
  command: process.execPath,
  args: [SERVER_BIN, "--transport=stdio"],
  // Pass MCP_TRUSTED so the future HTTP-transport child knows the parent
  // is the trusted principal (no JWT to verify) — see spec §7.2. Stdio
  // ignores it today, but flagging it now keeps the wiring explicit.
  //
  // ORCHESTRATOR_TOKEN: the child's network/tool handlers call BACK into
  // this orchestrator's /api surface and inject
  // `process.env.ORCHESTRATOR_TOKEN` as the bearer
  // (services/mcp-server/src/index.ts). Compose defines SERVICE_TOKEN_MCP on
  // the orchestrator container but never ORCHESTRATOR_TOKEN (that name is
  // only wired on the SIBLING http mcp-server container), so on a
  // provisioned box (AUTH_ENABLED=true) every chat-path tool call 401'd one
  // hop in — the exact failure class this PR fixes (review blocker). Hand
  // the service-principal token to the child explicitly.
  env: {
    MCP_TRUSTED: "1",
    ...(config.SERVICE_TOKEN_MCP
      ? { ORCHESTRATOR_TOKEN: config.SERVICE_TOKEN_MCP }
      : {}),
  },
});

/**
 * WARP-2395 — what every caller holds is the MULTIPLEXER, not the stdio
 * child. With no remote server attached it delegates every member straight
 * through, so this is byte-for-byte the previous behaviour; the point is that
 * attaching one later is a call to `attachRemote`, not a change to the twelve
 * modules that import this name.
 *
 * The allowlist is read once at module load and ships EMPTY
 * (`REMOTE_MCP_SERVER_ALLOWLIST`, config.ts), so on any box that has not been
 * configured `attachRemote` refuses every server.
 *
 * WARP-2316 — the remote call policy is no longer the bare deny-everything
 * default. It is the compiled TABLES, layered OVER that default: a name in a
 * server's explicit read list is allowed (today `atlassian-tool-policy.ts`'s),
 * and everything else — every write, every tool nobody classified, and every
 * tool of a server no table speaks for — falls through to
 * {@link DENY_ALL_REMOTE_TOOLS}. WARP-3703: which table speaks for which server
 * is `remote-tool-tables.ts`'s registry, so a second vendor is a data entry
 * there and no change here.
 *
 * That is ADR-043 §3 read as written rather than relaxed: *"Read-only
 * invocation of tools an operator has explicitly demoted to read status under
 * §2 may ship before those land. Writes may not."* The table §2 requires now
 * exists, in this repo, reviewed as a diff on
 * `docs/security/atlassian-mcp-tool-surface.json`. Writes stay blocked.
 *
 * The observable behaviour on a shipping box is UNCHANGED, because the
 * allowlist is empty and no server can attach — the policy only matters once
 * an operator opts in.
 */
const remoteAllowlist = parseRemoteMcpAllowlist(config.REMOTE_MCP_SERVER_ALLOWLIST);

/**
 * Which server ids may attach.
 *
 * WARP-2900 — an `ext-<slug>` id is a promoted workshop extension, and ONLY
 * the extension lifecycle decides it: it must be in `installedExtensionIds`
 * (maintained from the Extension rows, never from env). The env allowlist
 * does not reach that namespace — an operator typing `ext-foo` into
 * REMOTE_MCP_SERVER_ALLOWLIST attaches nothing that was not promoted and
 * installed. Every other id is the operator allowlist, exactly as before.
 */
export function isRemoteServerAllowed(serverId: string): boolean {
  if (serverId.startsWith(EXTENSION_SERVER_PREFIX)) return installedExtensionIds.has(serverId);
  return remoteAllowlist.has(serverId);
}

// WARP-2426 — the operator-owned classification record, layered over the
// reviewed per-server tables: the record's `denied` wins over everything; its
// reviewed reads fill only the table's holes; the table's write-blocks are
// a floor no demotion reaches around. Read from a cache the attach path and
// the owner route refresh — a row the cache has not seen is "not
// classified", never "allowed".
//
// WARP-3703 — the table is the registry's, by server id. Atlassian's reviewed
// table is registered there exactly as it was built here (API-token mode, deny-all
// fallback), and a server with NO table is DENIED by default: the shipping
// deny-all, which the record may then fill one reviewed read at a time.
const vendorRemoteCallPolicy: RemoteCallPolicy = composeRemoteCallPolicy({
  lookup: remoteToolClassificationCache.lookup,
  table: remoteToolTablePolicy,
});

/**
 * WARP-2900 — no compiled table speaks for an extension, so for `ext-*` the
 * record is the whole authority (createRecordBackedRemoteCallPolicy): an
 * unreviewed tool is REMOTE_WRITE_NOT_PERMITTED (the confirming-write
 * default), a reviewed read runs, a block is final. Every other server keeps
 * the composed vendor policy above.
 */
const extensionRemoteCallPolicy: RemoteCallPolicy = createRecordBackedRemoteCallPolicy(
  remoteToolClassificationCache.lookup,
);

export const remoteCallPolicy: RemoteCallPolicy = (input) =>
  input.serverId.startsWith(EXTENSION_SERVER_PREFIX)
    ? extensionRemoteCallPolicy(input)
    : vendorRemoteCallPolicy(input);

export const mcpClient = new McpToolMultiplexer(localClient, {
  isServerAllowed: isRemoteServerAllowed,
  remoteCallPolicy,
  // WARP-2437 — a remote WRITE is routed through the SAME WARP-2305
  // interceptor the local tools use, and refuses when none is registered.
  // WARP-2214 builds the generic one; this is the registration point to swap
  // (and the stub in the multiplexer to remove) when it lands. No policy marks
  // a remote call a write yet, so this is dormant until remote writes are
  // deliberately enabled.
  writeInterceptor: defaultToolCallInterceptor,
  onConfirmationEvent: (event, ctx) => {
    void recordActivity(confirmationActivityParams(event, ctx)).catch(() => {
      // Recorder already swallows internally; defence-in-depth.
    });
  },
});

let started = false;

/**
 * WARP-2659 — the bridge client each successful attach opened, by server id.
 *
 * Held so {@link detachRemoteMcp} can CLOSE the session rather than only
 * forget it: the multiplexer holds the gated port, which has no `close`, and
 * this module is the only one that constructs the raw client.
 */
const attachedClients = new Map<string, McpBridgeClient>();

export async function ensureMcpStarted(): Promise<void> {
  if (started) return;
  await localClient.start();
  started = true;
}

export async function stopMcp(): Promise<void> {
  if (!started) return;
  await localClient.stop();
  started = false;
}

/**
 * WARP-3703 (ADR-043 TC-1.2) — attach ONE registered server, and keep what this
 * process needs of it afterwards.
 *
 * What `ensureRemoteMcpAttached` did for Atlassian alone, per registration, and
 * shared by the boot loop and the reconciler's re-open: a re-open is the SAME
 * gated attach the boot path runs, not a second implementation of "open a
 * session" that could drift from it (WARP-2651).
 */
async function attachRegistered(
  prisma: AttachRemoteDeps["prisma"],
  server: RemoteServerRegistration,
  /** WARP-2651 — the catalog a previous attach vetted. Absent at boot: this
   *  process has vetted nothing yet, and an empty baseline is not the same
   *  claim as no baseline. */
  knownTools?: readonly string[],
): Promise<RemoteAttachResult> {
  const result = await attachRemoteServer({
    ...server,
    mux: mcpClient,
    prisma,
    allowlist: remoteAllowlist,
    createClient: () => createBridgeClient(server.serverId),
    // WARP-2426 — the same client, seen through the classification surface.
    // `prisma` here is typed to the gate's narrow row shape; at runtime it is
    // the process-wide PrismaClient, which carries the model.
    classificationPrisma: prisma as unknown as AttachRemoteDeps["classificationPrisma"],
    ...(knownTools !== undefined ? { knownTools } : {}),
  });
  if (result.attached) {
    attachedClients.set(result.serverId, result.client);
    // The rows just recorded (and any operator decision since the last
    // refresh) become visible to the policy now, not on the next boot.
    try {
      const rows = await remoteToolClassificationCache.refresh(
        prisma as unknown as Parameters<typeof remoteToolClassificationCache.refresh>[0],
      );
      logger.info({ serverId: result.serverId, rows }, "remote_tool_classification_cache_refreshed");
    } catch (err) {
      logger.error({ err, serverId: result.serverId }, "remote_tool_classification_cache_refresh_failed");
    }
    logger.info(
      { serverId: result.serverId, tools: result.sync.registered.length },
      "remote_mcp_attached",
    );
  }
  return result;
}

/**
 * WARP-2627 — attach every outbound MCP session this box is entitled to.
 *
 * Called once from `index.ts` after the stdio child is up, and answers one
 * result per registered server (WARP-3703: it used to answer Atlassian's alone).
 * On the SHIPPING default — `REMOTE_MCP_SERVER_ALLOWLIST` empty — every server
 * is refused at the first gate, having touched no network, read no row and
 * constructed no client, so the boot path is byte-identical to before on every
 * unconfigured box.
 *
 * One at a time and in registry order: an attach lists the whole multiplexer
 * catalog, so concurrent attaches would read each other's half-attached state.
 * A server whose attach THROWS does not stop the ones after it — the point of
 * more than one server is that they do not share a fate — and the first failure
 * is rethrown once every server has been attempted, which is what the boot call's
 * own handler already logs.
 *
 * The socket lives in `services/mcp-bridge` (ADR-043 §5); what is constructed
 * here is an HTTP client for it, wrapped by the gate → audit front.
 */
export async function ensureRemoteMcpAttached(
  prisma: AttachRemoteDeps["prisma"],
  /** Injectable ONLY so a test can attach a server that exists nowhere else;
   *  production attaches every MCP-track provider the registry declares. */
  servers: readonly RemoteServerRegistration[] = registeredRemoteServers(),
): Promise<RemoteAttachResult[]> {
  const results: RemoteAttachResult[] = [];
  const failures: unknown[] = [];
  for (const server of servers) {
    try {
      results.push(await attachRegistered(prisma, server));
    } catch (err) {
      failures.push(err);
      logger.warn({ err, serverId: server.serverId }, "remote_mcp_attach_failed");
    }
  }
  if (failures.length > 0) throw failures[0];
  return results;
}

/**
 * WARP-2659 — tear down one remote server: the disconnect path.
 *
 * Handed to `createIntegrationsRouter` from `app.ts` rather than imported by
 * the integrations service (see `IntegrationsServiceDeps.remoteMcp` for the
 * cycle that would close). Idempotent: a server that was never attached — the
 * shipping default — detaches nothing and dials nothing.
 */
export async function detachRemoteMcp(serverId: string): Promise<void> {
  const client = attachedClients.get(serverId);
  attachedClients.delete(serverId);
  await detachRemoteServer({ mux: mcpClient, serverId, ...(client ? { client } : {}) });
}

/**
 * WARP-3912 (ADR-043 §4) - the `remote_mcp` channel was turned off: refuse new
 * calls (the gate already does, on its next read), abort the ones in flight,
 * and close every session this process holds (the bridge closes its streams
 * with the session). Idempotent; a box that attached nothing does nothing.
 */
export async function tearDownRemoteMcp(): Promise<void> {
  abortRemoteMcpInFlight();
  await Promise.all([...attachedClients.keys()].map((id) => detachRemoteMcp(id)));
}

/** One bridge client for a given server id. A factory rather than a singleton
 *  because the orphan sweep needs a client for an id this process never
 *  attached — the whole point of WARP-2651's failure (1). */
function createBridgeClient(serverId: string): McpBridgeClient {
  return new McpBridgeClient({
    baseUrl: config.MCP_BRIDGE_URL,
    serviceToken: config.MCP_BRIDGE_SERVICE_TOKEN,
    serverId,
  });
}

/**
 * WARP-2651 — the reconciler's production wiring.
 *
 * Every dependency is a thin adapter onto something that already exists: the
 * bridge client's `GET /sessions` and `DELETE`, the multiplexer's `detachRemote`, and
 * the SAME gated attach the boot path uses — so the re-open is not a second,
 * parallel implementation of "open a session" that could drift from the gated
 * one.
 *
 * WARP-3703 — `reattach` opens THE SERVER THE RECONCILER NAMED. It used to
 * ignore its `serverId`, because there was exactly one attachable server and a
 * generic re-open would have silently re-opened Atlassian for whatever id the
 * registry happened to hold; with more than one that is a different server's
 * credential going to the wrong place, so an id nobody registered is refused
 * rather than answered with some other server's attach.
 */
export function remoteMcpReconcilerDeps(
  prisma: AttachRemoteDeps["prisma"],
  /** Injectable ONLY so a test can re-open a server that exists nowhere else. */
  servers: readonly RemoteServerRegistration[] = registeredRemoteServers(),
): RemoteMcpReconcilerDeps {
  return {
    // `GET /sessions` is the whole bridge's inventory and answers the same
    // whichever server the client was built for; the client wants one id, so the
    // first registered server's is used.
    sessions: async () => {
      const probe = servers[0];
      if (!probe) throw new Error("no MCP server is registered, so there is no bridge inventory to read");
      return createBridgeClient(probe.serverId).sessions();
    },
    closeSession: async (serverId) => {
      await createBridgeClient(serverId).close();
    },
    detach: (serverId) => {
      mcpClient.detachRemote(serverId);
    },
    reattach: async (serverId, knownTools) => {
      const server = servers.find((s) => s.serverId === serverId);
      if (!server) {
        throw new Error(`no MCP server "${serverId}" is registered; refusing to re-open another in its place`);
      }
      return attachRegistered(prisma, server, knownTools);
    },
  };
}
