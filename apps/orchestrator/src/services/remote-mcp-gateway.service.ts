/**
 * WARP-2627 — the gate → audit front for every outbound MCP call.
 *
 * ## The shape, and where it comes from
 *
 * ADR-043 §5 names `services/web-fetch` fronted by
 * `apps/orchestrator/src/routes/web.ts` as the model, and quotes that route's
 * own docstring for the posture: **gate → cache → upstream, with an audit row
 * for each outcome, on EVERY request**. This module is that front for the MCP
 * bridge, with two deliberate differences the ADR itself calls out:
 *
 *   - **No cache.** §5: *"a remote tool invocation is neither idempotent nor
 *     safely keyable, and a cached `callTool` result is a correctness bug
 *     waiting to be filed."* Catalog listing MAY be cached; it is not cached
 *     here either, because the bridge's `catalog_changed` state is what detects
 *     a surface that moved under us and a cache in front of it would hide the
 *     drift it exists to catch.
 *   - **It is a PORT, not an Express route.** `routes/web.ts` is an HTTP route
 *     because its caller is the browser. This one's caller is the agent loop,
 *     in-process, through `McpClientPort` — so an Express route would mean the
 *     orchestrator dialling itself over loopback to reach a gate it already
 *     owns. The gate and the audit are what §5 asks for; the URL was never the
 *     point.
 *
 * ## The gate is three independent refusals, and each fails closed
 *
 *   1. **The bearer.** No `MCP_BRIDGE_SERVICE_TOKEN` ⇒ refuse without dialling
 *      (`mcp-bridge.client.ts`).
 *   2. **The operator allowlist.** `REMOTE_MCP_SERVER_ALLOWLIST` must name the
 *      server. EMPTY BY DEFAULT — a box nobody configured dials nothing.
 *   3. **The connection row.** An `IntegrationConnection` for this provider,
 *      with an explicit `status` of CONNECTED and a sealed credential in
 *      `providerTokensEnc` (ADR-042 §5). Read from the two EXPLICIT columns,
 *      never inferred from a NULL.
 *
 * A DB error is a REFUSAL, following `ambientDataGate`'s divergence from
 * `outboundEmailGate`: that service's own docstring records that its pre-merge
 * shim *"defaulted OPEN, which is exactly the wrong way for a sovereignty gate
 * to fail."* Here there is no operator split worth a 503 — every failure to
 * read the gate must simply refuse egress.
 *
 * ## Rule 19
 *
 * The audit row carries a server id, a tool name and a classified outcome. It
 * carries no credential, no vendor host, no arguments and no response body. The
 * host is deliberately absent: after this PR the bridge container is the only
 * thing that dials `mcp.atlassian.com`, and putting the literal back in
 * orchestrator code would make that claim harder to check than a grep.
 */
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "./activity.singleton.js";
import type {
  McpClientPort,
  McpToolCallOutcome,
  McpToolDescriptor,
} from "./mcp-client.port.js";
import { McpBridgeError } from "./mcp-bridge.client.js";
import { remoteCallAttribution, type RemoteCallAttribution } from "./remote-call-attribution.js";

const logger = createLogger("remote-mcp-gateway");

/** WARP-2409 — whose sign-in a call ran under: the asking member's own, the
 *  Workspace connection, or the shared API token. Recorded as `refs.credential`. */
export type RemoteMcpCredentialKind = "member" | "workspace" | "api-token";

/** A refusal made BEFORE any vendor call because no usable sign-in exists. */
export type RemoteMcpSignInRefusal = "REMOTE_SIGN_IN_REQUIRED" | "REMOTE_SIGN_IN_EXPIRED";

/**
 * WARP-2409 — an upstream that chooses the credential per call (the member
 * routing port). The gate prefers it over `callTool` so the audit row can say
 * which credential ran, and so a sign-in refusal is audited as a policy refusal.
 */
export interface CredentialAttributingPort extends McpClientPort {
  /** Credential the catalog session was opened with, for the listing audit. */
  readonly catalogCredential?: RemoteMcpCredentialKind;
  callToolAttributed(name: string, args: Record<string, unknown>): Promise<
    | { outcome: McpToolCallOutcome; credential: RemoteMcpCredentialKind }
    | { outcome: McpToolCallOutcome; refusal: RemoteMcpSignInRefusal }
  >;
}

const isAttributing = (p: McpClientPort): p is CredentialAttributingPort =>
  typeof (p as Partial<CredentialAttributingPort>).callToolAttributed === "function";

/** The two outbound operations this front covers. */
export type RemoteMcpOp = "list_tools" | "call_tool";

/** What lands in `refs.outcome`. A fixed set, like `routes/web.ts`'s. */
export type RemoteMcpOutcome =
  | "allowed"
  | "refused_gate"
  // WARP-2439 — refused by the multiplexer before the gate (not in the vetted
  // catalog, or the call policy denied it). Still a call attempt worth a row.
  | "refused_policy"
  | "provider_error"
  | "aborted";

/**
 * Why the gate refused.
 *
 * Closed and specific, because these have DIFFERENT remedies and an operator
 * reads them: "you have not enabled this server" and "you have not connected
 * this account" are not the same instruction.
 */
export type RemoteMcpGateReason =
  | "server_not_allowlisted"
  | "no_connection_row"
  | "channel_disabled"
  | "connection_not_connected"
  | "no_credential"
  | "gate_unavailable";

export type RemoteMcpGateDecision =
  | { allowed: true }
  | { allowed: false; reason: RemoteMcpGateReason; message: string };

/** The minimal Prisma surface the gate needs, so a test passes a literal. */
export interface RemoteMcpGatePrisma {
  /** WARP-3912 — the `remote_mcp` off-LAN channel row. */
  offLanAllowlistChannel: {
    findUnique(args: unknown): Promise<{ enabled: boolean } | null>;
  };
  /**
   * WARP-2409 — rule 3 also passes on a signed-in connection. Optional so a
   * caller without the model sees only the API-token rung (fail closed).
   */
  mcpOAuthConnection?: {
    count(args: unknown): Promise<number>;
  };
  integrationConnection: {
    findFirst(args: unknown): Promise<{
      id: string;
      status: string;
      providerTokensEnc: string | null;
    } | null>;
  };
}

/**
 * Read the gate for one server.
 *
 * Both halves are explicit reads. `status === "CONNECTED"` is the enum column,
 * not "a row exists"; `providerTokensEnc !== null` is the credential column,
 * not "the status looks fine". The repo rule is that persistent state is a
 * declared value, and a connection whose credential was purged while the status
 * column still said CONNECTED is precisely the row this catches.
 */
export async function remoteMcpGate(
  prisma: RemoteMcpGatePrisma,
  serverId: string,
  allowlist: ReadonlySet<string>,
): Promise<RemoteMcpGateDecision> {
  if (!allowlist.has(serverId)) {
    return {
      allowed: false,
      reason: "server_not_allowlisted",
      message:
        `"${serverId}" is not in REMOTE_MCP_SERVER_ALLOWLIST. No session is opened and ` +
        "nothing from it is callable.",
    };
  }
  // WARP-3912 — the owner's master switch, after the allowlist (an unconfigured box
  // still reads nothing) and before the connection row. Explicit `enabled`, never
  // "a row exists"; a missing row or a failed read both refuse.
  try {
    const channel = await prisma.offLanAllowlistChannel.findUnique({ where: { key: "remote_mcp" } });
    if (channel?.enabled !== true) {
      return {
        allowed: false,
        reason: "channel_disabled",
        message:
          "Remote MCP servers are switched off by the workspace owner (off-LAN channel remote_mcp). " +
          "Nothing was sent; ask the owner or an admin to turn it on in Settings.",
      };
    }
  } catch (err) {
    logger.warn({ err, serverId }, "remote_mcp channel read failed — failing closed (no egress)");
    return {
      allowed: false,
      reason: "gate_unavailable",
      message: "The remote MCP gate could not be read. Refusing egress.",
    };
  }
  let row: { id: string; status: string; providerTokensEnc: string | null } | null;
  try {
    row = await prisma.integrationConnection.findFirst({
      where: { provider: serverId },
      select: { id: true, status: true, providerTokensEnc: true },
    });
  } catch (err) {
    logger.warn({ err, serverId }, "remote_mcp gate read failed — failing closed (no egress)");
    return {
      allowed: false,
      reason: "gate_unavailable",
      message: "The remote MCP gate could not be read. Refusing egress.",
    };
  }
  // WARP-2409 — a CONNECTED sign-in (a member's or the Workspace's) satisfies rule 3
  // when the API-token connection does not. Which one a CALL uses is decided
  // per call (member-routing.port.ts); this only says the server may be dialled.
  if (!(row?.status === "CONNECTED" && row.providerTokensEnc !== null) && prisma.mcpOAuthConnection) {
    try {
      if ((await prisma.mcpOAuthConnection.count({ where: { provider: serverId, state: "CONNECTED" } })) > 0) {
        return { allowed: true };
      }
    } catch (err) {
      logger.warn({ err, serverId }, "remote_mcp sign-in read failed — failing closed (no egress)");
      return {
        allowed: false,
        reason: "gate_unavailable",
        message: "The remote MCP gate could not be read. Refusing egress.",
      };
    }
  }
  if (!row) {
    return {
      allowed: false,
      reason: "no_connection_row",
      message: `No ${serverId} connection is configured on this box.`,
    };
  }
  if (row.status !== "CONNECTED") {
    return {
      allowed: false,
      reason: "connection_not_connected",
      message: `The ${serverId} connection is ${row.status}, not CONNECTED.`,
    };
  }
  if (row.providerTokensEnc === null) {
    return {
      allowed: false,
      reason: "no_credential",
      message: `The ${serverId} connection holds no credential.`,
    };
  }
  return { allowed: true };
}

/** One signed activity row per outbound operation — the `routes/web.ts` idiom.
 *  Fire-and-forget: the agent turn never waits on the append lock. */
export function auditRemoteMcp(input: {
  serverId: string;
  op: RemoteMcpOp;
  outcome: RemoteMcpOutcome;
  tool?: string;
  reason?: string;
  /** Who the call ran for. Defaults to the multiplexer's in-process scope
   *  (remote-call-attribution.ts); a caller outside that scope passes it. */
  /** WARP-2409 — whose credential the call ran under. A name, never a token. */
  credential?: RemoteMcpCredentialKind;
  who?: RemoteCallAttribution;
}): void {
  // WARP-2439 — the requesting member, the way the stdio `tool_call` row names
  // them: the Nextcloud USERNAME in `refs.userId`, not a UUID, so the actor
  // stays `ai` (WARP-181: `user` requires a canonical UUID). Ids and names
  // only — never argument values or result content (rule 19).
  const who = input.who ?? remoteCallAttribution();
  void recordActivity({
    kind: "network",
    severity: input.outcome === "allowed" ? "info" : "warn",
    sourceIcon: "globe",
    what: `Remote MCP: ${input.serverId}`,
    sub: who?.userId ? `remote_mcp for ${who.userId}` : "remote_mcp",
    refs: {
      channel: "remote_mcp",
      serverId: input.serverId,
      op: input.op,
      outcome: input.outcome,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.credential ? { credential: input.credential } : {}),
      ...(who?.userId ? { userId: who.userId } : {}),
      ...(who?.agentRunId ? { agentRunId: who.agentRunId } : {}),
    },
    // The agent loop is what drives a remote tool call, so `ai` — the same
    // mapping `network-safety.service.ts` applies to MCP-channel network ops.
    actor: { type: "ai", id: null },
  });
}

/**
 * WARP-3912 — every in-flight remote call, by server id. Turning `remote_mcp` off
 * aborts them all (ADR-043 §4: tear down, do not merely decline to re-establish).
 * Process-wide because the switch is: the one chokepoint below registers every
 * call, so a future owner-added server is covered without wiring of its own.
 */
const inFlight = new Map<string, Set<AbortController>>();

/** Abort every in-flight remote call (one server, or all). Returns how many. */
export function abortRemoteMcpInFlight(serverId?: string): number {
  let n = 0;
  for (const [id, set] of inFlight) {
    if (serverId !== undefined && id !== serverId) continue;
    for (const ac of set) {
      ac.abort();
      n++;
    }
  }
  return n;
}

/** Run `fn`, rejecting as soon as the switch aborts it. The bridge session close
 *  that follows ({@link detachRemoteServer}) is what stops the upstream work. */
async function abortable<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let set = inFlight.get(serverId);
  if (!set) inFlight.set(serverId, (set = new Set()));
  set.add(ac);
  try {
    return await new Promise<T>((resolve, reject) => {
      ac.signal.addEventListener(
        "abort",
        () =>
          reject(
            new McpBridgeError(
              "REMOTE_MCP_GATE_REFUSED",
              "Remote MCP was switched off by the workspace owner while this call was running. It was aborted.",
              451,
            ),
          ),
        { once: true },
      );
      fn().then(resolve, reject);
    });
  } finally {
    set.delete(ac);
    if (set.size === 0) inFlight.delete(serverId);
  }
}

export interface GatedRemoteMcpPortOptions {
  serverId: string;
  /** The bridge-backed port. Never a socket this process owns (ADR-043 §5). */
  upstream: McpClientPort;
  /** Read on EVERY call, like `routes/web.ts` reads `ambientDataGate`. */
  gate: () => Promise<RemoteMcpGateDecision>;
  /** Injected so a test asserts on rows without a database. */
  audit?: typeof auditRemoteMcp;
}

/**
 * Wrap a bridge port so every call passes the gate and lands an audit row.
 *
 * The refusal shape differs per method, deliberately:
 *
 *   - `listTools` THROWS. The multiplexer catches it, records
 *     `REMOTE_CATALOG_UNAVAILABLE` in `rejections()` and keeps the local
 *     registry working — ADR-043 §1's rule that a vanished catalog must not
 *     read as "there is nothing to do".
 *   - `callTool` RETURNS an error outcome. The model is mid-turn and needs a
 *     sentence it can act on; a thrown exception would surface as a failed turn
 *     rather than as "this tool is not available and here is why".
 */
export function createGatedRemoteMcpPort(opts: GatedRemoteMcpPortOptions): McpClientPort {
  const audit = opts.audit ?? auditRemoteMcp;
  const { serverId, upstream, gate } = opts;

  return {
    get isStarted(): boolean {
      return upstream.isStarted;
    },

    async listTools(): Promise<McpToolDescriptor[]> {
      const decision = await gate();
      if (!decision.allowed) {
        audit({ serverId, op: "list_tools", outcome: "refused_gate", reason: decision.reason });
        throw new McpBridgeError("REMOTE_MCP_GATE_REFUSED", decision.message, 451);
      }
      try {
        const tools = await abortable(serverId, () => upstream.listTools());
        const catalogCredential = isAttributing(upstream) ? upstream.catalogCredential : undefined;
        audit({ serverId, op: "list_tools", outcome: "allowed", ...(catalogCredential ? { credential: catalogCredential } : {}) });
        return tools;
      } catch (err) {
        audit({
          serverId,
          op: "list_tools",
          outcome: aborted(err) ? "refused_gate" : isAbort(err) ? "aborted" : "provider_error",
          reason: isAbort(err) ? "aborted" : err instanceof McpBridgeError ? err.code : "unknown",
        });
        throw err;
      }
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpToolCallOutcome> {
      const decision = await gate();
      if (!decision.allowed) {
        audit({
          serverId,
          op: "call_tool",
          outcome: "refused_gate",
          tool: name,
          reason: decision.reason,
        });
        return errorOutcome("REMOTE_MCP_GATE_REFUSED", name, decision.message);
      }
      try {
        if (isAttributing(upstream)) {
          const r = await abortable(serverId, () => upstream.callToolAttributed(name, args));
          if ("refusal" in r) {
            // No usable sign-in: refused before the vendor, the same policy refusal as a denied tool.
            audit({ serverId, op: "call_tool", outcome: "refused_policy", tool: name, reason: r.refusal });
          } else {
            audit({ serverId, op: "call_tool", outcome: "allowed", tool: name, credential: r.credential });
          }
          return r.outcome;
        }
        const result = await abortable(serverId, () => upstream.callTool(name, args));
        audit({ serverId, op: "call_tool", outcome: "allowed", tool: name });
        return result;
      } catch (err) {
        const code = err instanceof McpBridgeError ? err.code : "REMOTE_CALL_FAILED";
        audit({
          serverId,
          op: "call_tool",
          outcome: aborted(err) ? "refused_gate" : isAbort(err) ? "aborted" : "provider_error",
          tool: name,
          reason: isAbort(err) ? "aborted" : code,
        });
        return errorOutcome(
          code,
          name,
          err instanceof Error ? err.message : "The remote MCP call failed.",
        );
      }
    },
  };
}

/** WARP-2439 — a caller-side abort is its own outcome, not a provider fault. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** The switch aborted this call (see {@link abortable}) - a refusal, not a vendor failure. */
const aborted = (err: unknown): boolean =>
  err instanceof McpBridgeError && err.code === "REMOTE_MCP_GATE_REFUSED";

/** Same envelope `mcp-multiplexer.service.ts` uses for a refusal, so the model
 *  sees one shape whichever layer refused. */
export function errorOutcome(code: string, tool: string, message: string): McpToolCallOutcome {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, tool, message }) }],
  };
}
