/**
 * WARP-2627 — the orchestrator's side of the ADR-043 §5 line.
 *
 * ## What this is
 *
 * An {@link McpClientPort} whose calls travel over HTTP to `services/mcp-bridge`
 * instead of down a socket this process owns. ADR-043 §5: *"The orchestrator
 * process MUST NOT open a session to a remote MCP server"*, and it names the
 * tripwire — `StreamableHTTPClientTransport` in orchestrator product code is a
 * breach. This file imports no MCP SDK, constructs no transport, and knows no
 * vendor host; it knows a base URL, a bearer, and six paths.
 *
 * ## Why the wire types are re-declared here instead of imported
 *
 * `@droplet/mcp-bridge` is deliberately NOT a dependency of this workspace.
 * Importing its barrel would pull `streamable-http.ts` — and therefore
 * `StreamableHTTPClientTransport` — into the orchestrator's module graph, which
 * is the exact thing §5 tells a reviewer to look for. A type-only import would
 * be erased at runtime but would still put the package in `package.json`, where
 * the next person to write `import { … }` gets no signal at all.
 *
 * So the wire contract is duplicated, on purpose, and the duplication is GATED
 * rather than trusted: `adr-043-boundary.test.ts` reads the bridge's own source
 * and fails if either side's vocabulary drifts. A mismatch that slipped through
 * would surface as an explicit `UNKNOWN_SERVER_ID` from the bridge, never as an
 * empty tool list.
 *
 * ## Fail-closed
 *
 * No bearer configured ⇒ every method refuses WITHOUT dialling. That is
 * `routes/web.ts`'s posture for `WEB_FETCH_SERVICE_TOKEN` ("502 fail-closed,
 * logged, WITHOUT calling upstream") applied to a hop that carries a customer's
 * vendor credential rather than a weather lookup.
 */
import { createLogger } from "../lib/logger.js";
import type {
  McpClientPort,
  McpToolCallOutcome,
  McpToolDescriptor,
} from "./mcp-client.port.js";

const logger = createLogger("mcp-bridge-client");

/**
 * Every state an outbound session can be in, as the bridge reports it.
 *
 * Mirrors `services/mcp-bridge/src/session-state.ts`'s
 * `REMOTE_MCP_SESSION_STATES`, and the mirror is checked — see the module
 * header. An explicit closed union, never a boolean and never derived from an
 * empty tool list (repo rule: no guessing state).
 */
export const REMOTE_MCP_SESSION_STATES = [
  "idle",
  "connecting",
  "ready",
  "reconnecting",
  "auth_rejected",
  "unreachable",
  "protocol_mismatch",
  "catalog_changed",
  "closed",
] as const;

export type RemoteMcpSessionState = (typeof REMOTE_MCP_SESSION_STATES)[number];

/** Operator-facing session health. Carries no credential and no vendor error
 *  text — the bridge builds `reason` from error shape, never from server text. */
export interface RemoteMcpSessionHealth {
  serverId: string;
  state: RemoteMcpSessionState;
  toolCount: number;
  consecutiveFailures: number;
  lastReadyAt: number | null;
  reason: string | null;
}

/** The bridge's refusal vocabulary. Mirrors `http-api.ts`'s
 *  `BridgeErrorCode`; the mirror is gated by `adr-043-boundary.test.ts`. */
export const BRIDGE_ERROR_CODES = [
  "AUTH_NOT_CONFIGURED",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INVALID_REQUEST",
  "UNKNOWN_SERVER_ID",
  "SESSION_NOT_OPEN",
  // WARP-2409 - the bridge's per-connection sessions (gated by adr-043-boundary.test.ts).
  "NO_SESSION",
  "CATALOG_ONLY",
  "SESSION_NOT_READY",
  "REMOTE_CALL_FAILED",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/** Raised for every non-2xx answer, and for a refusal made before dialling.
 *  Carries the bridge's code so a caller switches on a value, not a message. */
export class McpBridgeError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly httpStatus: number,
    readonly state?: RemoteMcpSessionHealth,
    /** `/oauth/*` only: why the bridge refused (e.g. `HOST_NOT_ALLOWED`), or the
     *  authorization server's own `error` (e.g. `invalid_grant`). Both come off
     *  the wire as short codes, never as server text. */
    readonly reason?: string,
  ) {
    super(message);
    this.code = code;
    this.name = "McpBridgeError";
  }
}

/**
 * The credential handed to the bridge at open time. Never persisted here,
 * never logged, never returned — it is read out of the ADR-042 seam, passed
 * through, and dropped (rule 19).
 *
 * WARP-3703 — the credential and identity fields are NAMED BY THE SERVER'S
 * PROFILE, not fixed: Atlassian's are `email`, `apiToken` and `cloudId`, a
 * bearer-only vendor's is a single token field whose name is that vendor's own.
 * They stay the flat JSON keys the wire has always carried, so no caller needs a
 * lockstep deploy. The attach path builds them from the provider descriptor's
 * required `credentialFields`; the bridge refuses a body missing any field its
 * profile declares; and `adr-043-boundary.test.ts` gates that the two agree.
 */
export interface McpBridgeOpenInput {
  readonly [field: string]: string | boolean | readonly string[] | undefined;
  /**
   * WARP-2409 - set when the base (catalog) session is opened with a PERSONAL
   * sign-in (an owner or admin's): the bridge then answers 409 `CATALOG_ONLY` to
   * any `/call` on it, so that person's token can list tools but never answer
   * another member's call. Unset for the API token and the Workspace connection,
   * the shared credentials meant to answer calls.
   */
  catalogOnly?: boolean;
  /** Test-only override; the bridge screens it against its own host set. */
  url?: string;
  /**
   * WARP-2651 — the catalog this process last vetted, handed back so a
   * RE-OPENED session can still detect that the vendor's surface moved.
   *
   * Omitted on a first open, and that absence is meaningful: an empty array
   * would claim we vetted a surface with no tools in it, and every tool the
   * server advertises would then read as `added` drift on a brand-new box.
   */
  knownTools?: readonly string[];
}

/**
 * What `GET /sessions` answers: the bridge's inventory, behind the bearer.
 *
 * Mirrors `http-api.ts`'s `BridgeSessionsBody`, and the mirror is gated by
 * `remote-mcp-reconciler.bridge-contract.test.ts`, which drives the bridge's
 * REAL router for this read rather than a fixture that models it.
 *
 * It used to ride on the unauthenticated `/health` — and this client used to
 * read it there — until stage commit 952e0d78 (WARP-2300 review) moved it.
 * `/health` is readable by every container on the compose bridge network, and
 * `sessions` says whether the customer has connected a vendor and whether
 * their credential is being rejected. `/health` now answers the constant
 * `{status:"ok"}` and nothing else; a reader that still expected `sessions`
 * there gets `undefined` and throws on every tick.
 */
export interface BridgeSessionsBody {
  knownServers: string[];
  /** Every session the BRIDGE currently holds — including ones this process
   *  does not own, which is the whole point of reading it (WARP-2651). */
  sessions: RemoteMcpSessionHealth[];
  /** WARP-2409 - per server id, how many per-connection (member or Workspace)
   *  sessions the bridge holds. A count only: no ids, no members. The orphan
   *  sweep reads `sessions` (base sessions) and ignores this. */
  connectionSessions?: Record<string, number>;
}

export interface McpBridgeClientOptions {
  baseUrl: string;
  serviceToken: string;
  serverId: string;
  /** Injected in tests. Never globally patched. */
  fetchImpl?: typeof fetch;
  /** Abort budget for one bridge call. */
  timeoutMs?: number;
}

/**
 * A remote MCP call can be a Jira search over a customer's whole site, so the
 * budget is generous compared with web-fetch's 10 s — but bounded, because an
 * agent turn that never returns is worse than one that reports a timeout.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The shape a server id may have — the bridge's `SERVER_ID_PATTERN`
 * (`http-api.ts`) and the multiplexer's, restated.
 *
 * Checked at construction because every path this client builds interpolates
 * `serverId`, and one caller hands over an id it READ FROM THE BRIDGE'S
 * RESPONSE rather than a constant: the reconciler's orphan sweep, which
 * `DELETE`s whatever `GET /sessions` listed. The bridge is ours and behind the
 * bearer, but a path segment is a path segment — refuse before dialling rather
 * than trust the wire to only ever say `atlassian`.
 */
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A connection id is the `McpOAuthConnection` uuid; refuse anything else before it reaches a body. */
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // lowercase only, as Prisma's uuid()
function assertConnectionId(id: string): void {
  if (!CONNECTION_ID_PATTERN.test(id)) {
    throw new McpBridgeError("INVALID_CONNECTION_ID", "connectionId is not a valid connection id.", 0);
  }
}

export class McpBridgeClient implements McpClientPort {
  readonly serverId: string;
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /**
   * Explicit, and written only by {@link open} / {@link close}.
   *
   * NOT derived from "have we ever had a catalog" or from a tool count: the
   * repo rule is that persistent status is a declared value. `false` here means
   * this process has not opened a session, which is a different fact from the
   * bridge's own session state and is never conflated with it.
   */
  #opened = false;
  #closeEpoch = 0;

  /**
   * The tool names the BRIDGE advertised on the last successful `listTools`.
   *
   * WARP-2651's drift baseline, and it is the bridge's names rather than the
   * multiplexer's vetted subset on purpose: a tool the multiplexer drops (an
   * illegal wire name, a collision with a local tool) is still a tool the
   * vendor advertises, so baselining on the subset would make it read as
   * `added` drift on every re-open and pin the session in `catalog_changed`
   * for good.
   */
  #lastAdvertised: readonly string[] = [];
  #lastDefinitionHashes: ReadonlyMap<string, string> = new Map();
  #lastListed: readonly (McpToolDescriptor & { definitionHash?: string })[] = [];
  #onListed: ((tools: readonly (McpToolDescriptor & { definitionHash?: string })[]) => void | Promise<void>) | null = null;

  constructor(opts: McpBridgeClientOptions) {
    if (!SERVER_ID_PATTERN.test(opts.serverId)) {
      // Names the rule, never the value: the id came off the wire.
      throw new McpBridgeError(
        "INVALID_SERVER_ID",
        "serverId is not a valid bridge server id (lowercase letters, digits and hyphens; at most 32).",
        0,
      );
    }
    this.serverId = opts.serverId;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#serviceToken = opts.serviceToken;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isStarted(): boolean {
    return this.#opened;
  }

  /** Open (or re-open) the session. The bridge replaces any existing one. */
  async open(input: McpBridgeOpenInput): Promise<RemoteMcpSessionHealth> {
    const body = await this.#send<{ state: RemoteMcpSessionHealth }>(
      "POST",
      `/sessions/${this.serverId}/open`,
      input,
    );
    // A per-connection session (WARP-2409) is not THIS client's base session.
    if (typeof input.connectionId !== "string") this.#opened = true;
    return body.state;
  }

  /**
   * WARP-2409 — dispatch one call on a member's or the Workspace's own
   * bridge session (keyed by the `McpOAuthConnection` id). A 409 `NO_SESSION`
   * means the bridge no longer holds it; the caller re-opens and retries once.
   */
  async callToolFor(connectionId: string, name: string, args: Record<string, unknown>): Promise<McpToolCallOutcome> {
    assertConnectionId(connectionId);
    const body = await this.#send<{ result: McpToolCallOutcome }>(
      "POST",
      `/sessions/${this.serverId}/call`,
      { name, args, connectionId },
    );
    return body.result;
  }

  /** WARP-2409 — close one per-connection session (sign-out, refresh failure). */
  async closeConnection(connectionId: string): Promise<void> {
    assertConnectionId(connectionId);
    await this.#send("POST", `/sessions/${this.serverId}/close`, { connectionId });
  }

  /** Bumps on every {@link close}: the bridge tears down every per-connection
   *  session with the base one, so a cache keyed on this knows to drop its own. */
  get closeEpoch(): number {
    return this.#closeEpoch;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const body = await this.#send<{ tools: (McpToolDescriptor & { definitionHash?: string })[] }>(
      "GET",
      `/sessions/${this.serverId}/tools`,
    );
    this.#lastAdvertised = body.tools.map((t) => t.name);
    this.#lastListed = body.tools;
    // WARP-3918 — the bridge hashes the whole wire object (annotations
    // included, which never reach this process). Kept by wire name.
    this.#lastDefinitionHashes = new Map(
      body.tools.flatMap((t) => (typeof t.definitionHash === "string" ? [[t.name, t.definitionHash] as const] : [])),
    );
    if (this.#onListed) {
      try {
        await this.#onListed(body.tools);
      } catch (err) {
        logger.error({ err, serverId: this.serverId }, "mcp_bridge_on_listed_failed");
      }
    }
    return body.tools;
  }

  /** WARP-3918 — the last listing as the bridge sent it (descriptions and hashes). */
  lastListedTools(): readonly (McpToolDescriptor & { definitionHash?: string })[] {
    return this.#lastListed;
  }

  /** WARP-3918 — wire name → the bridge's definition hash, from the last listing. */
  lastDefinitionHashes(): ReadonlyMap<string, string> {
    return this.#lastDefinitionHashes;
  }

  /** WARP-3918 — called after every successful listing (it runs per agent
   *  turn), so a definition that changes mid-session is seen, not only one
   *  that changed before a re-attach. Must not throw; a throw is logged. */
  onListed(handler: (tools: readonly (McpToolDescriptor & { definitionHash?: string })[]) => void | Promise<void>): void {
    this.#onListed = handler;
  }

  /** {@link #lastAdvertised}. Empty until a listing has succeeded — never a
   *  guess about what the server would have said. */
  lastAdvertisedToolNames(): readonly string[] {
    return this.#lastAdvertised;
  }

  /**
   * The bridge's inventory: every session IT holds, and the ids it can open.
   *
   * The reconciler's read. Deliberately a whole-component read rather than
   * `state()` per server: case (1) of WARP-2651 is a session the orchestrator
   * does NOT know about, and a per-server read can only ever confirm what the
   * caller already named.
   *
   * `GET /sessions`, behind the bearer like every other route this client
   * calls — NOT `/health`, which the bridge serves without one and which
   * therefore says nothing about the customer (`http-auth.ts`).
   */
  async sessions(): Promise<BridgeSessionsBody> {
    return this.#send<BridgeSessionsBody>("GET", "/sessions");
  }

  /**
   * Dispatch one tool call.
   *
   * The third `context` parameter of {@link McpClientPort} is accepted and
   * IGNORED — `mcp-multiplexer.service.ts` already drops it on the remote path
   * (it carries a Nextcloud session token), and this port is only ever reached
   * through that drop. Taking the parameter keeps the port's shape; forwarding
   * it would be the bug.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallOutcome> {
    const body = await this.#send<{ result: McpToolCallOutcome }>(
      "POST",
      `/sessions/${this.serverId}/call`,
      { name, args },
    );
    return body.result;
  }

  async state(): Promise<RemoteMcpSessionHealth> {
    const body = await this.#send<{ state: RemoteMcpSessionHealth }>(
      "GET",
      `/sessions/${this.serverId}/state`,
    );
    return body.state;
  }

  /** Accept a changed catalog and return the session to `ready`. The caller
   *  has re-vetted the surface (ADR-043 §1's fourth failure state). */
  async acknowledgeCatalog(): Promise<RemoteMcpSessionHealth> {
    const body = await this.#send<{ state: RemoteMcpSessionHealth }>(
      "POST",
      `/sessions/${this.serverId}/acknowledge-catalog`,
    );
    return body.state;
  }

  async close(): Promise<void> {
    try {
      await this.#send("DELETE", `/sessions/${this.serverId}`);
    } finally {
      // Closed is closed even if the bridge was unreachable while we said so —
      // leaving `#opened` true would let a later call dial a session this
      // process has already disowned.
      this.#opened = false;
      this.#closeEpoch++;
    }
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return bridgeRequest<T>(
      { baseUrl: this.#baseUrl, serviceToken: this.#serviceToken, fetchImpl: this.#fetch, timeoutMs: this.#timeoutMs },
      method,
      path,
      body,
    );
  }
}

interface BridgeTransport {
  baseUrl: string;
  serviceToken: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/** One bearer-gated call to the bridge. Shared by the per-server client above
 *  and {@link McpBridgeOAuthClient}, so both fail closed identically. */
async function bridgeRequest<T>(t: BridgeTransport, method: string, path: string, body?: unknown): Promise<T> {
  if (t.serviceToken.length === 0) {
    // No dial. `routes/web.ts`'s rule, and the log line is the operator's
    // only signal that a secret was never provisioned.
    logger.error(
      "MCP_BRIDGE_SERVICE_TOKEN is unset — refusing %s %s (fail-closed, no upstream call)",
      method,
      path,
    );
    throw new McpBridgeError(
      "AUTH_NOT_CONFIGURED",
      "MCP_BRIDGE_SERVICE_TOKEN is not configured on the orchestrator.",
      0,
    );
  }
  let res: Response;
  try {
    res = await t.fetchImpl(`${t.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t.serviceToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(t.timeoutMs),
    });
  } catch (e) {
    // The bridge container itself is unreachable — a compose/health problem,
    // distinct from the VENDOR being unreachable (which arrives as a 502 with
    // a classified session state). Different remedies, so different codes.
    throw new McpBridgeError(
      "BRIDGE_UNREACHABLE",
      `mcp-bridge did not answer ${method} ${path}.`,
      0,
    );
  }

  const parsed = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: { code?: string; message?: string }; state?: RemoteMcpSessionHealth })
    | null;

  if (!res.ok) {
    // `/oauth/*`: 422 `OAUTH_PKCE_UNSUPPORTED` / `OAUTH_REFUSED` carry a top-level
    // `reason` (e.g. HOST_NOT_ALLOWED); 502 `OAUTH_TOKEN_ERROR` carries the
    // authorization server's `oauthError` (e.g. invalid_grant). A short code only.
    const raw = parsed?.reason ?? parsed?.oauthError;
    const reason = typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
    throw new McpBridgeError(
      parsed?.error?.code ?? "REMOTE_CALL_FAILED",
      parsed?.error?.message ?? `mcp-bridge answered ${res.status}.`,
      res.status,
      parsed?.state,
      reason,
    );
  }
  if (parsed === null) {
    throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered with no JSON body.", res.status);
  }
  return parsed as T;
}

// ─── WARP-2401 / WARP-2405 — the OAuth hops, made by the bridge ──────────────
//
// ADR-043 §5: every outbound hop to a vendor (discovery, client registration,
// code exchange, refresh, revoke) is the bridge's, through its DNS-pinned
// `guardedFetch`. The orchestrator never dials an authorization server. These
// bodies are the plan's contract with `services/mcp-bridge/src/oauth/`.

/** 422 `error.code`: the authorization server does not advertise PKCE S256. */
export const OAUTH_PKCE_UNSUPPORTED = "OAUTH_PKCE_UNSUPPORTED";

/** 422 `error.code`: any other refusal; `reason` says which (HOST_NOT_ALLOWED,
 *  RESOURCE_MISMATCH, ISSUER_MISMATCH, UNSAFE_URL, DISCOVERY_FAILED). */
export const OAUTH_REFUSED = "OAUTH_REFUSED";

/** 502 `error.code`: the authorization server answered a token request with an
 *  OAuth error; `reason` carries its `error` (e.g. `invalid_grant`). */
export const OAUTH_TOKEN_ERROR = "OAUTH_TOKEN_ERROR";

/** `reason` on a 422 `OAUTH_REFUSED`: an endpoint host the bridge's curated registry does not allow. */
export const OAUTH_HOST_NOT_ALLOWED = "HOST_NOT_ALLOWED";

/** What `POST /oauth/discover` answers: the vetted metadata of the server's authorization server. */
export interface McpOAuthDiscovery {
  /** The RFC 9728 `resource`; the bridge has checked it equals the MCP URL. */
  resource: string;
  /** The authorization server's `issuer`, string-equal to its own metadata. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /** RFC 9207 `authorization_response_iss_parameter_supported`. When true the
   *  callback MUST carry `iss`. */
  issParameterSupported: boolean;
}

/** The only fields kept from a token response. */
export interface McpOAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn?: number;
  scope?: string;
}

export interface McpOAuthExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** RFC 8707, sent on the token request as well as the authorize URL. */
  resource: string;
}

export interface McpOAuthRefreshInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource: string;
  scope?: string;
}

export interface McpOAuthRevokeInput {
  revocationEndpoint: string;
  clientId: string;
  clientSecret?: string;
  token: string;
}

export interface McpBridgeOAuthClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function tokenResult(raw: unknown): McpOAuthTokenResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  // Fail closed on a malformed answer; keep nothing beyond the four fields.
  if (!isStr(r.accessToken)) {
    throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered a token request without an access token.", 502);
  }
  return {
    accessToken: r.accessToken,
    ...(isStr(r.refreshToken) ? { refreshToken: r.refreshToken } : {}),
    ...(typeof r.expiresIn === "number" && Number.isFinite(r.expiresIn) ? { expiresIn: r.expiresIn } : {}),
    ...(isStr(r.scope) ? { scope: r.scope } : {}),
  };
}

/** The orchestrator's side of the bridge's `/oauth/*` routes. */
export class McpBridgeOAuthClient {
  readonly #t: BridgeTransport;

  constructor(opts: McpBridgeOAuthClientOptions) {
    this.#t = {
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
      serviceToken: opts.serviceToken,
      fetchImpl: opts.fetchImpl ?? fetch,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /** The bridge decides which hosts are allowed from its own curated registry;
   *  the box never sends a host list. */
  async discover(mcpUrl: string): Promise<McpOAuthDiscovery> {
    const d = await bridgeRequest<Partial<McpOAuthDiscovery> & { authorizationResponseIssParameterSupported?: unknown }>(
      this.#t, "POST", "/oauth/discover", { mcpUrl },
    );
    if (!isStr(d.resource) || !isStr(d.issuer) || !isStr(d.authorizationEndpoint) || !isStr(d.tokenEndpoint)) {
      throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered discovery with incomplete metadata.", 502);
    }
    return {
      resource: d.resource,
      issuer: d.issuer,
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      ...(isStr(d.registrationEndpoint) ? { registrationEndpoint: d.registrationEndpoint } : {}),
      ...(isStr(d.revocationEndpoint) ? { revocationEndpoint: d.revocationEndpoint } : {}),
      // Explicit true or false, never absence read as false by a caller.
      issParameterSupported: d.authorizationResponseIssParameterSupported === true,
    };
  }

  async register(registrationEndpoint: string, redirectUris: readonly string[]): Promise<{ clientId: string; clientSecret?: string }> {
    const r = await bridgeRequest<{ clientId?: unknown; clientSecret?: unknown }>(this.#t, "POST", "/oauth/register", {
      registrationEndpoint,
      redirectUris,
    });
    if (!isStr(r.clientId)) {
      throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered registration without a client id.", 502);
    }
    return { clientId: r.clientId, ...(isStr(r.clientSecret) ? { clientSecret: r.clientSecret } : {}) };
  }

  async exchange(input: McpOAuthExchangeInput): Promise<McpOAuthTokenResult> {
    return tokenResult(await bridgeRequest(this.#t, "POST", "/oauth/exchange", input));
  }

  async refresh(input: McpOAuthRefreshInput): Promise<McpOAuthTokenResult> {
    return tokenResult(await bridgeRequest(this.#t, "POST", "/oauth/refresh", input));
  }

  async revoke(input: McpOAuthRevokeInput): Promise<void> {
    await bridgeRequest(this.#t, "POST", "/oauth/revoke", input);
  }

  /** WARP-3961: the Atlassian sites a fresh access token reaches (the bridge
   *  opens a short bearer session; the token is the only thing sent). */
  async sites(accessToken: string): Promise<McpOAuthSite[]> {
    const r = await bridgeRequest<{ sites?: unknown }>(this.#t, "POST", "/oauth/sites", { accessToken });
    if (!Array.isArray(r.sites)) {
      throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered the site lookup without a list.", 502);
    }
    return r.sites.flatMap((s: unknown): McpOAuthSite[] => {
      const o = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
      return isStr(o.id) && isStr(o.url) && isStr(o.name) ? [{ id: o.id, url: o.url, name: o.name }] : [];
    });
  }
}

/** One Atlassian site a sign-in reaches. */
export interface McpOAuthSite {
  id: string;
  url: string;
  name: string;
}
