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
import { RemoteCallScheduler } from "./call-scheduler.js";
import type { RemoteMcpSession } from "./remote-session.js";
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

/**
 * Build the production Atlassian session factory.
 *
 * ONE scheduler per session, wired to BOTH ends of the rate-limit path:
 *
 *   - `createAtlassianMcpSession` gates every call through it (the #171
 *     concurrency ceiling), and
 *   - the transport's fetch feeds it the response's rate-limit headers.
 *
 * The second half is why this is a builder rather than the two-line literal it
 * used to be. The scheduler has to be in scope where the transport is
 * constructed, and it was not: the factory was a module-level constant, the
 * scheduler was created inside `createAtlassianMcpSession`, and the only thing
 * connecting them was `rateLimitHeadersOf(err)` reading a `headers` property
 * the pinned SDK does not put on its errors. The mitigation was inert.
 *
 * `makeScheduler` is injected ONLY so `rate-limit-seam.test.ts` can hold the
 * scheduler it is asserting counters on. Everything else — the client info the
 * #213 workaround makes load-bearing, the protocol pin, the guard stack, the
 * no-redirect fetch — is the shipped path, so that test exercises production
 * rather than a re-composition of it.
 */
export function createAtlassianSessionFactory(
  makeScheduler: () => RemoteCallScheduler = () => new RemoteCallScheduler(),
): SessionFactory {
  return (input: OpenSessionInput) => {
    const scheduler = makeScheduler();
    return createAtlassianMcpSession({
      email: input.email,
      apiToken: input.apiToken,
      cloudId: input.cloudId,
      scheduler,
      connect: (connectInput) =>
        createStreamableHttpConnection(connectInput, {
          clientInfo: ATLASSIAN_MCP_CLIENT_INFO,
          pinnedProtocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
          onRateLimitHeaders: (headers) => scheduler.noteRateLimitHeaders(headers),
        }),
      ...(input.url !== undefined ? { url: input.url } : {}),
    });
  };
}

/**
 * Every server id this component will open a session for.
 *
 * One entry today. A second server is a second entry here plus its own
 * `allowed-egress.yaml` registration — not a config value.
 */
export const SESSION_FACTORIES: Readonly<Record<string, SessionFactory>> =
  Object.freeze({
    [ATLASSIAN_SERVER_ID]: createAtlassianSessionFactory(),
  });

/** The ids {@link SESSION_FACTORIES} serves, sorted. Rendered by the
 *  bearer-gated `GET /sessions`, and by the `UNKNOWN_SERVER_ID` refusal. */
export function knownServerIds(
  factories: Readonly<Record<string, SessionFactory>> = SESSION_FACTORIES,
): string[] {
  return Object.keys(factories).sort();
}
