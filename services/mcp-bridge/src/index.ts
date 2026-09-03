/**
 * `@droplet/mcp-bridge` — the outbound MCP session component (ADR-043 §5).
 *
 * Droplet's MCP **server** half is `services/mcp-server`. This is the other
 * direction: the box dialling OUT to a server it does not own. The two are
 * separate workspaces on purpose — they have opposite trust postures, and the
 * ADR's rule that the orchestrator must not hold an outbound socket is only
 * checkable if there is exactly one place that opens one.
 *
 * WHAT IS HERE TODAY: the session core — lifecycle, bounded event-driven
 * reconnect, health, the four failure states, the exact-host guard and the
 * credential shapes (including the Atlassian headless Basic path).
 *
 * WHAT WARP-2316 ADDED: the first registered server. `atlassian.ts` holds the
 * one host literal in this workspace (`mcp.atlassian.com`, registered in
 * `docs/security/allowed-egress.yaml` in the same PR), the protocol pin, the
 * concurrency ceiling and the three guards that close upstream defects #213,
 * #221 and #171.
 *
 * WHAT WARP-2627 ADDED: the HTTP surface (`http-api.ts` + `server.ts`), the
 * closed server-id registry (`session-profiles.ts`) that finally composes the
 * SDK transport with the Atlassian profile, the bearer (`http-auth.ts`), a
 * Dockerfile and a profile-gated compose service. ADR-043 §5 required all of
 * that before `apps/orchestrator` could construct a session, which is why
 * nothing did until now.
 *
 * WHAT IS STILL NOT HERE: persistence of any kind. Sessions live in memory for
 * the life of the container, deliberately — ADR-043 §4's kill switch tears
 * sessions down, and a component that could restore one from disk would not be
 * torn down by it.
 */
export {
  BridgeSessionStore,
  handleBridgeRequest,
  type BridgeApiOptions,
  type BridgeCallBody,
  type BridgeErrorBody,
  type BridgeErrorCode,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStateBody,
  type BridgeToolsBody,
} from "./http-api.js";
export { AUTH_EXEMPT_PATHS, checkBridgeBearer, type BridgeAuthVerdict } from "./http-auth.js";
export { createBridgeServer, main, type BridgeServerOptions } from "./server.js";
export {
  knownServerIds,
  SESSION_FACTORIES,
  type OpenSessionInput,
  type SessionFactory,
} from "./session-profiles.js";
export {
  ATLASSIAN_ALLOWED_MCP_HOSTS,
  ATLASSIAN_CLOUD_ID_ARG,
  ATLASSIAN_MCP_CLIENT_INFO,
  ATLASSIAN_MCP_CLIENT_NAME,
  ATLASSIAN_MCP_CLIENT_VERSION,
  ATLASSIAN_MCP_HOST,
  ATLASSIAN_MCP_PROTOCOL_VERSION,
  ATLASSIAN_MCP_URL,
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_STRUCTURED_CONTENT_TOOLS,
  AtlassianStructuredContentUnavailableError,
  assertStructuredContentPresent,
  createAtlassianMcpSession,
  withAtlassianCloudId,
  withAtlassianGuards,
  withAtlassianStructuredContentGuard,
  withAtlassianTruncationGuard,
  withScheduler,
  type AtlassianMcpSessionOptions,
} from "./atlassian.js";
export {
  DEFAULT_MAX_CONCURRENT_CALLS,
  MAX_HONOURED_PAUSE_MS,
  RemoteCallScheduler,
  type RemoteCallSchedulerOptions,
  type RemoteCallSchedulerStats,
} from "./call-scheduler.js";
export {
  assertPinnedProtocolVersion,
  pinTransportProtocolVersion,
  ProtocolVersionMismatchError,
  type ProtocolVersionedTransport,
} from "./protocol-pin.js";
export {
  assertNotTruncated,
  ATLASSIAN_SEARCH_NODE_CAP,
  TruncatedResultError,
} from "./truncation.js";
export {
  basicCredential,
  bearerCredential,
  noCredential,
  type RemoteMcpCredential,
} from "./credentials.js";
export {
  RemoteMcpSession,
  RemoteMcpSessionNotReadyError,
  type CatalogDrift,
  type RemoteMcpConnection,
  type RemoteMcpConnectInput,
  type RemoteMcpConnectionFactory,
  type RemoteMcpSessionOptions,
  type RemoteToolCallOutcome,
  type RemoteToolDescriptor,
} from "./remote-session.js";
export {
  assertSafeMcpUrl,
  parseAllowedMcpHosts,
  UnsafeMcpUrlError,
} from "./safe-url.js";
export {
  classifyRemoteMcpError,
  FAILURE_STATES,
  NON_DISPATCHABLE_STATES,
  REMOTE_MCP_SESSION_STATES,
  type RemoteMcpErrorClass,
  type RemoteMcpFailureReason,
  type RemoteMcpSessionHealth,
  type RemoteMcpSessionState,
} from "./session-state.js";
export {
  createStreamableHttpConnection,
  MCP_BRIDGE_CLIENT_INFO,
  noRedirectFetch,
  type StreamableHttpConnectionOptions,
} from "./streamable-http.js";
