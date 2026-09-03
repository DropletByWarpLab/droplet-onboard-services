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
 * WHAT IS STILL NOT HERE: an HTTP listener, a Dockerfile and compose wiring.
 * ADR-043 §5 requires them before the ORCHESTRATOR can hold a session, so
 * nothing in `apps/orchestrator` constructs one today — see the gap note in
 * WARP-2316's PR body. The session core, the Atlassian profile and the
 * classification table are all reachable and tested without them.
 */
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
  type StreamableHttpConnectionOptions,
} from "./streamable-http.js";
