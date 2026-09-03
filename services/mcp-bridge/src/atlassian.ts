/**
 * WARP-2316 — the Atlassian remote MCP server, as this box dials it.
 *
 * ONE SERVER, ONE TRANSPORT, ONE CREDENTIAL SHAPE. Atlassian's MCP is
 * hosted-only: there is no self-hosted build to point at, so the endpoint is a
 * FIXED literal (`ATLASSIAN_MCP_URL`) rather than an operator-configured URL.
 * That is why its `docs/security/allowed-egress.yaml` entry is `kind: egress`
 * and not `kind: dynamic` — the host really is a repo literal the static
 * scanner can see, and this file is the literal it sees.
 *
 * ## The headless path, and why it exists at all
 *
 * `https://mcp.atlassian.com/v1/mcp` accepts `Authorization: Basic
 * base64(email:api_token)` and answers a full `initialize`. That is the entire
 * reason WARP-2316 is buildable on an appliance with no public inbound path
 * (ADR-009): the sibling endpoint `/v1/mcp/authv2` is OAuth 2.1, which needs a
 * browser redirect and a callback URL we do not have and will not open. OAuth
 * is an explicit v1 NON-GOAL — nothing in this module dials `auth.atlassian.com`
 * and no egress entry is registered for it. `/v1/sse` is deprecated upstream
 * and deliberately unimplemented.
 *
 * ADR-043 §7 classifies Atlassian as the **customer-created credential** model:
 * the customer's own org admin enables the Rovo MCP server and the customer
 * mints the API token. Warp Lab registers nothing, holds no shared identity,
 * and a revocation affects exactly one customer.
 *
 * ## What this module adds on top of {@link RemoteMcpSession}
 *
 * Four guards, each closing a documented upstream defect or a stated vendor
 * behaviour, all applied by decorating the connection rather than by teaching
 * the generic session about a vendor:
 *
 *   1. **Protocol pin** — {@link ATLASSIAN_MCP_PROTOCOL_VERSION}. See
 *      `protocol-pin.ts`; the SDK adopts whatever the server answers, and we
 *      do not.
 *   2. **`cloudId` on every call** — the API token is not bound to a site, so
 *      the site is an argument. Forced, not defaulted; see
 *      {@link withAtlassianCloudId}.
 *   3. **Truncation** — upstream #221. See `truncation.ts`.
 *   4. **`structuredContent` presence** — upstream #213. See below.
 *
 * ## Rule 19
 *
 * The API token reaches {@link basicCredential} and nothing else. It is not a
 * parameter of any exported type that is logged, not a field on the session,
 * and never appears in an error message — {@link AtlassianStructuredContentUnavailableError}
 * and friends carry a tool name and nothing from the request.
 */
import { basicCredential } from "./credentials.js";
import { pinTransportProtocolVersion } from "./protocol-pin.js";
import {
  RemoteMcpSession,
  type RemoteMcpConnection,
  type RemoteMcpConnectionFactory,
  type RemoteToolCallOutcome,
} from "./remote-session.js";
import { RemoteCallScheduler } from "./call-scheduler.js";
import { assertSafeMcpUrl } from "./safe-url.js";
import { assertNotTruncated } from "./truncation.js";

/** The one host this integration dials. A whole-string literal on purpose:
 *  `scripts/check-egress-allowlist.py` backs the `atlassian-mcp` registry
 *  entry with THIS line, and a host assembled from parts would not count. */
export const ATLASSIAN_MCP_HOST = "mcp.atlassian.com";

/** The Streamable-HTTP endpoint. Hosted-only — there is no self-hosted
 *  Atlassian MCP server, so this is fixed rather than configured. */
export const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v1/mcp";

/** The exact-host set for {@link assertSafeMcpUrl}. One host: ADR-043 §6's
 *  code-side guard, holding the same name the egress registry declares. */
export const ATLASSIAN_ALLOWED_MCP_HOSTS: ReadonlySet<string> = new Set([
  ATLASSIAN_MCP_HOST,
]);

/**
 * The MCP protocol version this integration speaks, PINNED.
 *
 * Atlassian's server negotiates up to `2025-11-25` and self-reports
 * `atlassian-mcp-server 1.0.0` while its published `server.json` says `1.1.3`
 * — so there is no server version to pin a contract to, and the protocol
 * version is the only stable thing in the handshake. We send this and we
 * REFUSE anything else, rather than adopting whatever comes back: the SDK's
 * own behaviour is `transport.setProtocolVersion(result.protocolVersion)`,
 * i.e. every subsequent request would carry the server's number. See
 * `protocol-pin.ts`.
 */
export const ATLASSIAN_MCP_PROTOCOL_VERSION = "2025-11-25";

/**
 * The `clientInfo.name` this box presents in `initialize` — upstream **#213**.
 *
 * #213: the server WITHHOLDS `structuredContent` (which is where `webUrl`
 * lives, i.e. the only machine-readable link back to the issue or page) unless
 * `clientInfo.name` is on a recognised-client list the server keeps. The list
 * is not published, and Warp Lab has no live Atlassian credential to probe it
 * with, so this value is NOT claimed to be on it.
 *
 * **We do not impersonate another vendor's client.** Sending someone else's
 * product name to unlock a response field would make the box lie about who it
 * is to a customer's own tenant, and it would break the moment the recognised
 * list changes. Instead the CONSEQUENCE is made legible:
 * {@link withAtlassianStructuredContentGuard} raises a typed error when a tool
 * that should carry `structuredContent` does not, so a degraded read never
 * renders as a complete one (ADR-041's rule, inherited by ADR-043 §1).
 *
 * Changing this constant changes whether the server enriches our responses.
 * `atlassian.test.ts`'s A/B regression test pins that dependency: a recognised
 * name yields `structuredContent`, an unrecognised one does not, and the guard
 * tells the two apart.
 */
export const ATLASSIAN_MCP_CLIENT_NAME = "droplet";

/** Version half of `clientInfo`. Not load-bearing; #213 keys on the name. */
export const ATLASSIAN_MCP_CLIENT_VERSION = "0.1.0";

export const ATLASSIAN_MCP_CLIENT_INFO = {
  name: ATLASSIAN_MCP_CLIENT_NAME,
  version: ATLASSIAN_MCP_CLIENT_VERSION,
} as const;

/** The server id this box namespaces Atlassian's tools under. Must satisfy
 *  `McpToolMultiplexer`'s server-id pattern (lowercase, no underscore). */
export const ATLASSIAN_SERVER_ID = "atlassian";

/**
 * The argument every Atlassian tool call carries.
 *
 * The API token is NOT bound to a site: one token reaches every site the
 * account can see, and the server picks the site from `cloudId`. That makes
 * the site an argument, and an argument the MODEL must not be able to choose —
 * so it is forced last in {@link withAtlassianCloudId}, overwriting anything
 * the model supplied. A model that could set `cloudId` could read a different
 * Atlassian site than the one the operator connected.
 */
export const ATLASSIAN_CLOUD_ID_ARG = "cloudId";

/**
 * Raised when a tool that should carry `structuredContent` returned none.
 *
 * Upstream #213. Not an empty result and not a silent one: `webUrl` is
 * missing, so anything built on the response is incomplete, and ADR-043 §1
 * inherits ADR-041's rule that a degraded read may never render as a complete
 * one.
 */
export class AtlassianStructuredContentUnavailableError extends Error {
  readonly code = "ATLASSIAN_STRUCTURED_CONTENT_UNAVAILABLE";
  constructor(readonly toolName: string) {
    super(
      `Atlassian returned no structuredContent for '${toolName}', so the result ` +
        "carries no webUrl. Upstream atlassian/atlassian-mcp-server#213: the server " +
        `withholds it unless clientInfo.name is a client it recognises (ours is ` +
        `'${ATLASSIAN_MCP_CLIENT_NAME}'). Treat the result as incomplete.`,
    );
    this.name = "AtlassianStructuredContentUnavailableError";
  }
}

/**
 * Tools whose result is expected to carry `structuredContent`.
 *
 * Named explicitly rather than "every tool", because plenty of Atlassian tools
 * legitimately answer with prose only and flagging those would make the guard
 * noise. These are the ones whose usefulness depends on the structured half —
 * they identify a specific object the caller then needs to link to.
 */
export const ATLASSIAN_STRUCTURED_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  "getJiraIssue",
  "createJiraIssue",
  "editJiraIssue",
  "searchJiraIssuesUsingJql",
  "getConfluencePage",
  "createConfluencePage",
  "searchConfluenceUsingCql",
  "search",
]);

export interface AtlassianMcpSessionOptions {
  /** The Atlassian account the customer minted the token on. */
  email: string;
  /** The customer's API token. Reaches {@link basicCredential} only. */
  apiToken: string;
  /** The site the operator connected. Forced onto every call. */
  cloudId: string;
  /** The transport factory. Injected in every test; production supplies
   *  {@link createStreamableHttpConnection}. */
  connect: RemoteMcpConnectionFactory;
  /** Overridable ONLY so a test can point at an RFC 2606 host. Screened
   *  against {@link ATLASSIAN_ALLOWED_MCP_HOSTS} either way, so an override
   *  cannot widen the host set. */
  url?: string;
  /** Shared across the session, so the ceiling is per-connection and not
   *  per-call. Defaults to a fresh {@link RemoteCallScheduler}. */
  scheduler?: RemoteCallScheduler;
  /** Passed through to {@link RemoteMcpSession}. */
  maxReconnectAttempts?: number;
  scheduleRetry?: (delayMs: number, run: () => void) => void;
  now?: () => number;
  /** WARP-2651 — the caller's already-vetted catalog, so `catalog_changed`
   *  survives a restart of this container. See `remote-session.ts`. */
  knownToolNames?: readonly string[];
}

/**
 * Build the Atlassian session.
 *
 * The URL is screened by {@link assertSafeMcpUrl} against a one-host set
 * before anything else happens, so a mis-set override fails at construction
 * with a legible refusal rather than at first dial with a transport error.
 */
export function createAtlassianMcpSession(
  opts: AtlassianMcpSessionOptions,
): RemoteMcpSession {
  const url = assertSafeMcpUrl(opts.url ?? ATLASSIAN_MCP_URL, ATLASSIAN_ALLOWED_MCP_HOSTS);
  const scheduler = opts.scheduler ?? new RemoteCallScheduler();

  return new RemoteMcpSession({
    serverId: ATLASSIAN_SERVER_ID,
    url,
    credential: basicCredential(opts.email, opts.apiToken),
    connect: withAtlassianGuards(opts.connect, opts.cloudId, scheduler),
    ...(opts.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: opts.maxReconnectAttempts }
      : {}),
    ...(opts.scheduleRetry ? { scheduleRetry: opts.scheduleRetry } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.knownToolNames !== undefined
      ? { knownToolNames: opts.knownToolNames }
      : {}),
  });
}

/**
 * Compose the four Atlassian-specific guards over a transport factory.
 *
 * Order matters and is asserted by `atlassian.test.ts`:
 *
 *   scheduler (outermost — a refused call must not consume a slot late)
 *     → cloudId  (the call the server actually receives)
 *       → truncation  (#221, reads the response)
 *         → structuredContent  (#213, reads the response)
 *
 * Each is exported separately so a reader can see one rule at a time and a
 * test can exercise one rule at a time.
 */
export function withAtlassianGuards(
  connect: RemoteMcpConnectionFactory,
  cloudId: string,
  scheduler: RemoteCallScheduler,
): RemoteMcpConnectionFactory {
  return async (input) => {
    const inner = await connect(input);
    return withScheduler(
      withAtlassianCloudId(
        withAtlassianStructuredContentGuard(withAtlassianTruncationGuard(inner)),
        cloudId,
      ),
      scheduler,
    );
  };
}

/** Decorate a connection so every call runs under the concurrency ceiling and
 *  any `Retry-After` / `X-RateLimit-*` the server sends is honoured. */
export function withScheduler(
  inner: RemoteMcpConnection,
  scheduler: RemoteCallScheduler,
): RemoteMcpConnection {
  return {
    ...inner,
    listTools: () => scheduler.run(() => inner.listTools()),
    callTool: (name, args) =>
      scheduler.run(async () => {
        try {
          return await inner.callTool(name, args);
        } catch (err) {
          const headers = rateLimitHeadersOf(err);
          if (headers) scheduler.noteRateLimitHeaders(headers);
          throw err;
        }
      }),
    close: () => inner.close(),
    onClosed: (h) => inner.onClosed(h),
  };
}

/**
 * Force `cloudId` onto every call.
 *
 * Spread LAST, deliberately. The model supplies `args`; if `args` could win,
 * a prompt-injected `cloudId` would redirect the call to a different Atlassian
 * site that the same token can also reach — the token is site-agnostic, which
 * is precisely what makes this a security property rather than a convenience.
 */
export function withAtlassianCloudId(
  inner: RemoteMcpConnection,
  cloudId: string,
): RemoteMcpConnection {
  if (cloudId.length === 0) {
    throw new Error("Atlassian session requires a cloudId — the API token is not site-bound");
  }
  return {
    ...inner,
    listTools: () => inner.listTools(),
    callTool: (name, args) =>
      inner.callTool(name, { ...args, [ATLASSIAN_CLOUD_ID_ARG]: cloudId }),
    close: () => inner.close(),
    onClosed: (h) => inner.onClosed(h),
  };
}

/** Upstream #221 — see `truncation.ts`. */
export function withAtlassianTruncationGuard(
  inner: RemoteMcpConnection,
): RemoteMcpConnection {
  return {
    ...inner,
    listTools: () => inner.listTools(),
    callTool: async (name, args) => {
      const outcome = await inner.callTool(name, args);
      assertNotTruncated(name, outcome);
      return outcome;
    },
    close: () => inner.close(),
    onClosed: (h) => inner.onClosed(h),
  };
}

/** Upstream #213 — see {@link ATLASSIAN_MCP_CLIENT_NAME}. */
export function withAtlassianStructuredContentGuard(
  inner: RemoteMcpConnection,
): RemoteMcpConnection {
  return {
    ...inner,
    listTools: () => inner.listTools(),
    callTool: async (name, args) => {
      const outcome = await inner.callTool(name, args);
      assertStructuredContentPresent(name, outcome);
      return outcome;
    },
    close: () => inner.close(),
    onClosed: (h) => inner.onClosed(h),
  };
}

/**
 * Raise when a tool listed in {@link ATLASSIAN_STRUCTURED_CONTENT_TOOLS} came
 * back without `structuredContent`. An error result (`isError`) is exempt —
 * a failure legitimately carries no structured half, and flagging it would
 * replace the server's own error with ours.
 */
export function assertStructuredContentPresent(
  toolName: string,
  outcome: RemoteToolCallOutcome,
): void {
  if (outcome.isError) return;
  if (!ATLASSIAN_STRUCTURED_CONTENT_TOOLS.has(toolName)) return;
  if (outcome.structuredContent === undefined || outcome.structuredContent === null) {
    throw new AtlassianStructuredContentUnavailableError(toolName);
  }
}

/** Pull the rate-limit headers off whatever the transport threw, without
 *  reading (or retaining) any other header. Rule 19. */
function rateLimitHeadersOf(err: unknown): Record<string, string> | null {
  if (typeof err !== "object" || err === null) return null;
  const raw = (err as { headers?: unknown }).headers;
  if (typeof raw !== "object" || raw === null) return null;
  const wanted = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (wanted.includes(k.toLowerCase()) && typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Re-exported so a caller wiring the real transport does not have to know
 *  that the pin lives in a different module. */
export { pinTransportProtocolVersion };
