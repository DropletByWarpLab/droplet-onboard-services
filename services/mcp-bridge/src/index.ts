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
 * WHAT IS NOT: an HTTP listener, a Dockerfile, compose wiring, and any host
 * literal. All four land with the first registered server (WARP-2316), which
 * is also the PR where `docs/security/allowed-egress.yaml` gains the entry
 * and a security reviewer sees the registration and the guard together.
 */
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
} from "./streamable-http.js";
