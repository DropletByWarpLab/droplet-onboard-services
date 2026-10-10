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
 *
 * WARP-3703 (ADR-043 TC-1.1) — an entry is a {@link SessionProfile}: the factory
 * AND the fields the wire must carry before it runs. The open contract used to
 * be a single shape every server shared (`email`, `apiToken`, `cloudId`),
 * because Atlassian was the only server. A vendor that presents one static
 * Bearer token has neither an email nor a site, so each profile now declares
 * its own, and `http-api.ts` validates the body against the profile the URL
 * names.
 */
import {
  ATLASSIAN_MCP_CLIENT_INFO,
  ATLASSIAN_MCP_PROTOCOL_VERSION,
  ATLASSIAN_MCP_OAUTH_URL,
  ATLASSIAN_REQUIRED_FIELDS,
  ATLASSIAN_REQUIRED_FIELD_SETS,
  ATLASSIAN_SERVER_ID,
  createAtlassianMcpSession,
} from "./atlassian.js";
import { RemoteCallScheduler } from "./call-scheduler.js";
import { bearerCredential } from "./credentials.js";
import type { RemoteMcpSession } from "./remote-session.js";
import { createStreamableHttpConnection } from "./streamable-http.js";

/**
 * What `POST /sessions/:serverId/open` carries, once the route has checked it
 * against the profile.
 *
 * Flat and open ON PURPOSE. The credential and identity fields are NAMED BY THE
 * PROFILE (`SessionProfile.requiredFields`): Atlassian's are `email`, `apiToken`
 * and `cloudId`; a bearer-only vendor's is one token field. They keep the flat
 * JSON keys the wire has always used, so no caller needs a lockstep deploy.
 *
 * A secret field (`apiToken`) reaches {@link createAtlassianMcpSession} →
 * `basicCredential`'s closure and nothing else: it is never stored on a session
 * field, never written to a log line, and never echoed in a response (rule 19).
 * The bridge holds no persistence of any kind, so it is gone when the container
 * stops.
 */
export interface OpenSessionInput {
  readonly [field: string]: string | readonly string[] | undefined;
  /** Overridable ONLY so a test can point at an RFC 2606 host. Screened
   *  against the profile's own allowed-host set either way. */
  readonly url?: string;
  /**
   * WARP-2651 — the catalog the caller has already vetted, carried across a
   * restart of THIS container.
   *
   * Not a credential and not a capability: it can only make the new session
   * refuse to dispatch (`catalog_changed`), never widen what it will serve. It
   * is absent on a first open, which is why it is optional rather than `[]`.
   */
  readonly knownTools?: readonly string[];
}

export type SessionFactory = (input: OpenSessionInput) => RemoteMcpSession;

/**
 * One server this component can dial: how to build its session, and what the
 * wire must carry for that to be possible.
 *
 * `requiredFields` are the flat JSON field names `POST /sessions/:serverId/open`
 * must carry as non-empty strings. The route refuses a body missing any of them
 * with a 400 that names the FIELD, never a value, and only then builds the
 * session — so a factory may assume them. They are the second half of a wire
 * contract whose first half is the provider descriptor's required
 * `credentialFields` in the orchestrator; `adr-043-boundary.test.ts` gates the
 * pair, because a mismatch would present as "could not open a session" rather
 * than as the naming error it is.
 */
export interface SessionProfile {
  readonly requiredFields: readonly string[];
  /**
   * WARP-2409 — alternative field sets the open body may carry (API token, or a
   * member's OAuth bearer). Absent means `[requiredFields]`. `requiredFields`
   * stays the API-token set so the orchestrator's descriptor gate is unchanged.
   */
  readonly requiredFieldSets?: readonly (readonly string[])[];
  readonly factory: SessionFactory;
}

/**
 * The contract every factory had before profiles existed: the three Atlassian
 * fields.
 *
 * A bare {@link SessionFactory} handed to `BridgeSessionStore` — the form every
 * harness written before WARP-3703 uses — is held to it, so those harnesses
 * behave as they always did. Nothing in {@link SESSION_PROFILES} takes this
 * path: production entries are profiles and declare their own. A constant of its
 * OWN rather than an alias of `ATLASSIAN_REQUIRED_FIELDS`, so changing
 * Atlassian's contract cannot silently move this one.
 */
export const BARE_FACTORY_REQUIRED_FIELDS: readonly string[] = Object.freeze([
  "email",
  "apiToken",
  "cloudId",
]);

/** Accept either form a registry entry may take. A profile passes through
 *  untouched; a bare factory is wrapped with {@link BARE_FACTORY_REQUIRED_FIELDS}. */
export function toSessionProfile(entry: SessionProfile | SessionFactory): SessionProfile {
  return typeof entry === "function"
    ? { requiredFields: BARE_FACTORY_REQUIRED_FIELDS, factory: entry }
    : entry;
}

/**
 * One flat open-input field, as the string it must be.
 *
 * The route has already refused a body missing any of the profile's
 * `requiredFields`, so this throws only for a factory called directly. It names
 * the FIELD and never a value, and it refuses rather than building half a
 * session: without it an absent `cloudId` would not fail until the first
 * `connect()`, inside the guard stack, long after the open had answered.
 */
function requireField(input: OpenSessionInput, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`open input is missing: ${name}`);
  }
  return value;
}

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
    // WARP-2409 — a member's OAuth bearer dials the OAuth endpoint; the route
    // has already refused a body that mixes it with the API-token fields.
    const bearer = typeof input.accessToken === "string" && input.accessToken.length > 0;
    return createAtlassianMcpSession({
      ...(bearer
        ? {
            credential: bearerCredential(requireField(input, "accessToken")),
            // Forced: a bearer is never presented anywhere but the OAuth endpoint.
            url: ATLASSIAN_MCP_OAUTH_URL,
          }
        : {
            email: requireField(input, "email"),
            apiToken: requireField(input, "apiToken"),
            ...(input.url !== undefined ? { url: input.url } : {}),
          }),
      cloudId: requireField(input, "cloudId"),
      scheduler,
      connect: (connectInput) =>
        createStreamableHttpConnection(connectInput, {
          clientInfo: ATLASSIAN_MCP_CLIENT_INFO,
          pinnedProtocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
          onRateLimitHeaders: (headers) => scheduler.noteRateLimitHeaders(headers),
        }),
      // WARP-2651 — the caller's vetted catalog, carried across a restart of
      // this container. It has to be handed over HERE, inside the production
      // builder: `http-api.ts` validates the wire field and `BridgeSessionStore`
      // passes it to this factory, so a factory that forgot it would parse the
      // baseline and then drop it — drift detection silently off on every
      // re-open, which is the exact failure the 400 guard on the route exists
      // to prevent. `catalog-baseline.test.ts` drives this factory to prove it.
      ...(input.knownTools !== undefined
        ? { knownToolNames: input.knownTools }
        : {}),
    });
  };
}

/**
 * Every server this component will open a session for.
 *
 * One entry today. A second server is a second entry here plus its own
 * `allowed-egress.yaml` registration — not a config value. Frozen entry by
 * entry, because a profile's `requiredFields` decides what the route accepts for
 * a customer's credential.
 */
export const SESSION_PROFILES: Readonly<Record<string, SessionProfile>> =
  Object.freeze({
    [ATLASSIAN_SERVER_ID]: Object.freeze({
      requiredFields: ATLASSIAN_REQUIRED_FIELDS,
      requiredFieldSets: ATLASSIAN_REQUIRED_FIELD_SETS,
      factory: createAtlassianSessionFactory(),
    }),
  });

/**
 * The factories {@link SESSION_PROFILES} serves — a VIEW of it, derived rather
 * than declared, so the two cannot drift. Kept for the callers that predate
 * profiles and only ever needed the factory.
 */
export const SESSION_FACTORIES: Readonly<Record<string, SessionFactory>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(SESSION_PROFILES).map(([id, profile]) => [id, profile.factory]),
    ),
  );

/** The ids a registry serves, sorted. Rendered by the bearer-gated
 *  `GET /sessions`, and by the `UNKNOWN_SERVER_ID` refusal. */
export function knownServerIds(
  registry: Readonly<Record<string, unknown>> = SESSION_PROFILES,
): string[] {
  return Object.keys(registry).sort();
}
