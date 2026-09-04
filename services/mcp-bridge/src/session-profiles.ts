/**
 * WARP-2627 — which remote MCP servers this component knows how to dial.
 *
 * A CLOSED registry, not a URL parameter. The orchestrator names a server id on
 * the wire (`POST /sessions/atlassian/open`) and this map decides what that id
 * means; an id with no entry is refused with `UNKNOWN_SERVER_ID` and nothing is
 * dialled. The alternative — letting the caller supply the URL — would move the
 * host decision to the wire, where `assertSafeMcpUrl`'s allowed-host set could
 * not be a per-server constant and `docs/security/allowed-egress.yaml`'s
 * `code_refs` would point at a literal that no longer decides anything.
 *
 * This is also where the production transport is finally wired. #1944 built
 * `createStreamableHttpConnection` and #1956 built `createAtlassianMcpSession`,
 * but nothing composed them, because there was no process to hold the socket.
 * There is now, and this is the composition: the SDK-backed factory, with the
 * `clientInfo` upstream #213 makes load-bearing and the protocol version
 * `protocol-pin.ts` refuses to let the server choose.
 */
import {
  ATLASSIAN_MCP_CLIENT_INFO,
  ATLASSIAN_MCP_PROTOCOL_VERSION,
  ATLASSIAN_SERVER_ID,
  createAtlassianMcpSession,
} from "./atlassian.js";
import type { RemoteMcpConnectionFactory, RemoteMcpSession } from "./remote-session.js";
import { createStreamableHttpConnection } from "./streamable-http.js";

/**
 * What `POST /sessions/:serverId/open` carries.
 *
 * `apiToken` is the customer's credential. It reaches
 * {@link createAtlassianMcpSession} → `basicCredential`'s closure and nothing
 * else: it is never stored on a session field, never written to a log line, and
 * never echoed in a response (rule 19). The bridge holds no persistence of any
 * kind, so it is gone when the container stops.
 */
export interface OpenSessionInput {
  email: string;
  apiToken: string;
  cloudId: string;
  /** Overridable ONLY so a test can point at an RFC 2606 host. Screened
   *  against the profile's own allowed-host set either way. */
  url?: string;
}

export type SessionFactory = (input: OpenSessionInput) => RemoteMcpSession;

/** The production Atlassian transport: SDK Streamable HTTP, the #213 client
 *  name, and the pinned protocol version. */
const atlassianConnect: RemoteMcpConnectionFactory = (input) =>
  createStreamableHttpConnection(input, {
    clientInfo: ATLASSIAN_MCP_CLIENT_INFO,
    pinnedProtocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
  });

/**
 * Every server id this component will open a session for.
 *
 * One entry today. A second server is a second entry here plus its own
 * `allowed-egress.yaml` registration — not a config value.
 */
export const SESSION_FACTORIES: Readonly<Record<string, SessionFactory>> =
  Object.freeze({
    [ATLASSIAN_SERVER_ID]: (input: OpenSessionInput) =>
      createAtlassianMcpSession({
        email: input.email,
        apiToken: input.apiToken,
        cloudId: input.cloudId,
        connect: atlassianConnect,
        ...(input.url !== undefined ? { url: input.url } : {}),
      }),
  });

/** The ids {@link SESSION_FACTORIES} serves, sorted. Rendered by the
 *  bearer-gated `GET /sessions`, and by the `UNKNOWN_SERVER_ID` refusal. */
export function knownServerIds(
  factories: Readonly<Record<string, SessionFactory>> = SESSION_FACTORIES,
): string[] {
  return Object.keys(factories).sort();
}
