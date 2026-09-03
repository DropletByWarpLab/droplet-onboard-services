/**
 * WARP-2398 — the ONE file in the repo that constructs an OUTBOUND MCP
 * transport.
 *
 * ADR-043 §5 names the reviewer's tripwire explicitly: *"a reviewer who sees
 * `StreamableHTTPClientTransport` or `SSEClientTransport` land in orchestrator
 * product code should treat it as a breach of this ADR."* Keeping the import
 * to a single file in this component is what makes that check a grep rather
 * than an audit.
 *
 * WHY STREAMABLE HTTP and not SSE: both are client-initiated, so both satisfy
 * §1's dial-out-only rule, but Streamable HTTP is the current MCP transport
 * and is what `mcp.atlassian.com/v1/mcp` speaks. SSE stays unimplemented
 * until a server we must reach only offers it.
 *
 * NOTHING HERE DIALS IN CI. `RemoteMcpSession` takes the factory as an
 * argument; every test in this workspace supplies a double, and this module is
 * exercised only for its option-shaping.
 *
 * SDK pin: `^1.30.0`, per `docs/mcp-client-sdk-version.md`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pinTransportProtocolVersion } from "./protocol-pin.js";
import type {
  RemoteMcpConnection,
  RemoteMcpConnectInput,
  RemoteToolCallOutcome,
  RemoteToolDescriptor,
} from "./remote-session.js";

/** Identity this component presents in the MCP `initialize` handshake. */
export const MCP_BRIDGE_CLIENT_INFO = {
  name: "droplet-mcp-bridge",
  version: "0.1.0",
} as const;

/**
 * Per-server overrides of the handshake.
 *
 * Both fields exist because of ONE server, and both are documented at their
 * Atlassian call sites (`atlassian.ts`): `clientInfo` because upstream #213
 * makes the client's NAME change what the server returns, and
 * `pinnedProtocolVersion` because the SDK otherwise adopts whatever version
 * the server answers with (`protocol-pin.ts`). Neither is a general knob — a
 * second server should state its own reason before setting either.
 */
export interface StreamableHttpConnectionOptions {
  clientInfo?: { name: string; version: string };
  /**
   * Refuse the session unless the negotiated protocol version is exactly this,
   * then keep sending exactly this. Omitted means the SDK's default: accept
   * and adopt any of its five supported versions.
   */
  pinnedProtocolVersion?: string;
}

/**
 * Reconnection is handled by {@link RemoteMcpSession}, on a classification of
 * WHY the transport dropped. The SDK's own reconnector cannot make that
 * distinction — it would re-dial a revoked credential — so it is turned down
 * to a single attempt rather than left at its default of two behind our own.
 */
const TRANSPORT_RECONNECTION = {
  maxRetries: 1,
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 2,
} as const;

/**
 * Build a live Streamable-HTTP connection to a remote MCP server.
 *
 * `input.url` MUST already have passed `assertSafeMcpUrl` — this factory does
 * not re-screen, and the guard belongs at configuration time where the
 * refusal can be shown to an operator.
 */
export const createStreamableHttpConnection = async (
  input: RemoteMcpConnectInput,
  opts: StreamableHttpConnectionOptions = {},
): Promise<RemoteMcpConnection> => {
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    // The credential rides here and nowhere else. `headers` is built fresh by
    // the credential closure per connect (see `credentials.ts`), so nothing
    // long-lived holds the material.
    requestInit: { headers: { ...input.headers } },
    reconnectionOptions: { ...TRANSPORT_RECONNECTION },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  const client = new Client(opts.clientInfo ?? MCP_BRIDGE_CLIENT_INFO, {
    capabilities: {},
  });
  await client.connect(transport);
  if (opts.pinnedProtocolVersion !== undefined) {
    // Immediately after connect and before ANY other request: the SDK has
    // just stored the server's chosen version on the transport, and every
    // subsequent request would carry it. `protocol-pin.ts` explains why that
    // is a downgrade we must not accept silently. A refusal here leaves the
    // transport open, so close it rather than leaking a socket to a server we
    // are declining to talk to.
    try {
      pinTransportProtocolVersion(transport, opts.pinnedProtocolVersion);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  return {
    async listTools(): Promise<RemoteToolDescriptor[]> {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        // ADR-043 §2 — `t.annotations` is NOT read. Copying only these three
        // fields is what makes "the wire cannot assert its own privilege" a
        // property of the code rather than a promise in a comment.
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as object,
      }));
    },
    async callTool(name, args): Promise<RemoteToolCallOutcome> {
      // No `_meta`: per `mcp-multiplexer.service.ts`, session context
      // (Nextcloud token, username, confirmation token) is trusted-stdio
      // material and never crosses to a server we do not own.
      const res = await client.callTool({ name, arguments: args });
      return {
        content: (res.content ?? []) as { type: string; text?: string }[],
        isError: Boolean(res.isError),
        // Carried, not interpreted here. Its ABSENCE is meaningful (upstream
        // #213) so it is passed through as `undefined` rather than defaulted.
        structuredContent: res.structuredContent,
      };
    },
    async close(): Promise<void> {
      await client.close();
    },
    onClosed(handler): void {
      transport.onclose = () => handler(undefined);
      transport.onerror = (err) => handler(err);
    },
  };
};
