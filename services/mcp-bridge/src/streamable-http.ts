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
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { pickRateLimitHeaders } from "./call-scheduler.js";
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
  /**
   * Called with a response's rate-limit headers, and ONLY those
   * ({@link pickRateLimitHeaders}), for every response the transport receives.
   *
   * This is the seam that makes upstream #171's mitigation real. The scheduler
   * knows how to pause; until WARP-2300 review nothing fed it, because the only
   * feed was `rateLimitHeadersOf(err)` in `atlassian.ts` reading `err.headers`
   * off whatever `client.callTool` rejected with — and the pinned SDK throws
   * `StreamableHTTPError`, which is constructed from a code and a message and
   * DISCARDS the `Response` (`streamableHttp.js`, the `throw` at the end of the
   * `!response.ok` branch). No `headers`, so no pause, ever, on a real box.
   * `call-scheduler.test.ts` stayed green throughout because all four of its
   * rate-limit tests call `noteRateLimitHeaders` directly.
   *
   * Fired on EVERY response, not only on a 429: `X-RateLimit-Remaining: 0` on
   * a 200 is the signal that lets the scheduler slow down BEFORE the vendor
   * starts refusing, which is the whole point of the header. The scheduler
   * ignores a positive remaining and caps any honoured pause at
   * `MAX_HONOURED_PAUSE_MS`, so a chatty or hostile header set cannot wedge a
   * session.
   */
  onRateLimitHeaders?: (headers: Record<string, string>) => void;
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
 * The transport's fetch, with redirects REFUSED.
 *
 * `assertSafeMcpUrl` screens the host once, at construction. Node's default
 * `redirect: "follow"` then lets the screened host hand the request — WITH the
 * customer's `Authorization` header on it — to any other host by answering
 * 302, and nothing re-screens the new authority. That turns a one-time
 * exact-host guard into a suggestion. `"error"` makes the built-in fetch
 * reject instead of following, so a redirect surfaces as a connect failure the
 * session classifies rather than as a credential delivered somewhere else.
 *
 * Exported so the option can be tested without opening a socket: nothing in
 * this workspace dials in CI.
 */
export const noRedirectFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, redirect: "error" });

/**
 * {@link noRedirectFetch}, plus the one thing only this layer can see.
 *
 * The transport's `fetch` is the LAST place in this process that holds the
 * live `Response`. The SDK reads what it needs and throws the rest away, so a
 * rate-limit header observed anywhere further out is a header that no longer
 * exists. Reading it here is not a convenience — it is the only correct place.
 *
 * Rule 19 is enforced by construction: {@link pickRateLimitHeaders} is handed
 * a lookup, and the callback receives a map that can contain nothing but
 * {@link RATE_LIMIT_HEADER_NAMES}. The rest of the response's headers are
 * never materialised, so an `Authorization` echo or a `Set-Cookie` is out of
 * reach rather than merely unread.
 *
 * The observer is invoked in a `try`/`catch` that swallows: a throwing sink
 * must not turn a healthy response into a transport failure, and must not turn
 * a 429 into a different error than the one the session classifies.
 */
export function createObservingFetch(
  onRateLimitHeaders?: (headers: Record<string, string>) => void,
): FetchLike {
  if (!onRateLimitHeaders) return noRedirectFetch;
  return async (url, init) => {
    const response = await fetch(url, { ...init, redirect: "error" });
    const picked = pickRateLimitHeaders((name) => response.headers.get(name));
    if (picked) {
      try {
        onRateLimitHeaders(picked);
      } catch {
        // See above. The response is the caller's business either way.
      }
    }
    return response;
  };
}

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
    // ADR-043 §6's exact-host guard is registration-time only; this is what
    // keeps it true for the life of the session. See `noRedirectFetch`. The
    // same wrapper is where the rate-limit headers are read, because it is the
    // last place the `Response` exists — see `onRateLimitHeaders`.
    fetch: createObservingFetch(opts.onRateLimitHeaders),
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
