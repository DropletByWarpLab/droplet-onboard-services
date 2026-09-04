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

const logger = createLogger("remote-mcp-gateway");

/** The two outbound operations this front covers. */
export type RemoteMcpOp = "list_tools" | "call_tool";

/** What lands in `refs.outcome`. A fixed set, like `routes/web.ts`'s. */
export type RemoteMcpOutcome = "allowed" | "refused_gate" | "provider_error";

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
  | "connection_not_connected"
  | "no_credential"
  | "gate_unavailable";

export type RemoteMcpGateDecision =
  | { allowed: true }
  | { allowed: false; reason: RemoteMcpGateReason; message: string };

/** The minimal Prisma surface the gate needs, so a test passes a literal. */
export interface RemoteMcpGatePrisma {
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
}): void {
  void recordActivity({
    kind: "network",
    severity: input.outcome === "allowed" ? "info" : "warn",
    sourceIcon: "globe",
    what: `Remote MCP: ${input.serverId}`,
    sub: "remote_mcp",
    refs: {
      channel: "remote_mcp",
      serverId: input.serverId,
      op: input.op,
      outcome: input.outcome,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    // The agent loop is what drives a remote tool call, so `ai` — the same
    // mapping `network-safety.service.ts` applies to MCP-channel network ops.
    actor: { type: "ai", id: null },
  });
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
        const tools = await upstream.listTools();
        audit({ serverId, op: "list_tools", outcome: "allowed" });
        return tools;
      } catch (err) {
        audit({
          serverId,
          op: "list_tools",
          outcome: "provider_error",
          reason: err instanceof McpBridgeError ? err.code : "unknown",
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
        const result = await upstream.callTool(name, args);
        audit({ serverId, op: "call_tool", outcome: "allowed", tool: name });
        return result;
      } catch (err) {
        const code = err instanceof McpBridgeError ? err.code : "REMOTE_CALL_FAILED";
        audit({
          serverId,
          op: "call_tool",
          outcome: "provider_error",
          tool: name,
          reason: code,
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

/** Same envelope `mcp-multiplexer.service.ts` uses for a refusal, so the model
 *  sees one shape whichever layer refused. */
function errorOutcome(code: string, tool: string, message: string): McpToolCallOutcome {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, tool, message }) }],
  };
}
