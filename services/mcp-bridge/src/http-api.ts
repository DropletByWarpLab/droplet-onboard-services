/**
 * WARP-2627 — the bridge's internal HTTP surface, and the ADR-043 §5 line it
 * finally draws.
 *
 * ## Why this file exists
 *
 * ADR-043 §5 is binding: *"The orchestrator process MUST NOT open a session to
 * a remote MCP server"*, and names the shape to follow — `services/web-fetch`,
 * fronted by the orchestrator's gate → audit route. #1944 built the session and
 * #1956 built the Atlassian profile, but neither could be reached: there was no
 * listener, no image and no compose service, so `apps/orchestrator` constructed
 * nothing and no Atlassian tool ever reached the model. This is the listener.
 *
 * ## Shape
 *
 * Transport-agnostic ON PURPOSE. {@link handleBridgeRequest} is a pure-ish
 * function from a parsed request to a status and a JSON body; `server.ts` is
 * the ~60 lines of `node:http` that adapt a socket to it. That split is what
 * lets every test in this workspace exercise the real routing, the real auth
 * and the real session store without binding a port — the same "nothing dials,
 * nothing listens, in any test" property #1944 established for the session.
 *
 * ## No framework
 *
 * `node:http` and a switch, rather than Express. This workspace's ONLY
 * dependency is `@modelcontextprotocol/sdk`, and its CI leg's cost argument
 * (`ci.yml`) rests on it needing "a bare `npm ci` and nothing else". Seven routes
 * with no middleware, no templating and no static assets do not buy back the
 * dependency.
 *
 * ## Rule 19
 *
 * The customer's API token arrives in one request body, is handed to
 * `basicCredential`'s closure, and is referenced nowhere afterwards. It is
 * never a field on a session, never in a log line (this module logs a method, a
 * path, a status and a server id — never a body), and never in a response.
 * {@link RemoteMcpSessionHealth} is the only session detail that crosses back,
 * and its own docstring records that it is built from error *shape* rather than
 * server text.
 */
import { checkBridgeBearer } from "./http-auth.js";
import {
  RemoteMcpSession,
  type RemoteToolCallOutcome,
  type RemoteToolDescriptor,
} from "./remote-session.js";
import type { RemoteMcpSessionHealth } from "./session-state.js";
import {
  SESSION_FACTORIES,
  knownServerIds,
  type OpenSessionInput,
  type SessionFactory,
} from "./session-profiles.js";

/** Same pattern the multiplexer enforces on a server id, so a name this
 *  component accepts is a name the orchestrator can namespace. */
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One parsed request. Built by `server.ts` from a `node:http` request. */
export interface BridgeRequest {
  method: string;
  /** Path only — the query string is not read by any route. */
  path: string;
  authorization?: string | null;
  /** Parsed JSON body, or `undefined` for a body-less method. */
  body?: unknown;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

/**
 * Every refusal this surface can produce.
 *
 * A closed vocabulary because the orchestrator switches on it: the gate has to
 * tell "the operator has not provisioned the shared secret" apart from "this
 * box is not connected to that vendor" apart from "the vendor is down", and
 * those have three different remedies (ADR-041 §1, inherited by ADR-043).
 */
export type BridgeErrorCode =
  | "AUTH_NOT_CONFIGURED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_REQUEST"
  | "UNKNOWN_SERVER_ID"
  | "SESSION_NOT_OPEN"
  | "SESSION_NOT_READY"
  | "REMOTE_CALL_FAILED";

export interface BridgeErrorBody {
  error: { code: BridgeErrorCode; message: string };
  /** Present when a session exists, so a caller never has to make a second
   *  request to learn WHY a call was refused. */
  state?: RemoteMcpSessionHealth;
}

export interface BridgeToolsBody {
  tools: RemoteToolDescriptor[];
  state: RemoteMcpSessionHealth;
}

export interface BridgeCallBody {
  result: RemoteToolCallOutcome;
  state: RemoteMcpSessionHealth;
}

export interface BridgeStateBody {
  state: RemoteMcpSessionHealth;
}

/**
 * `GET /sessions` — the inventory, and the one route that describes THIS BOX
 * rather than one named session.
 *
 * It lives behind the bearer because that is what it is: `knownServers` says
 * which vendors this build can reach, and `sessions` says whether the customer
 * has connected one and whether their credential is being rejected. Both used
 * to ride on the unauthenticated `/health`, where every container on the
 * compose bridge network could read them with no credential at all.
 */
export interface BridgeSessionsBody {
  knownServers: string[];
  sessions: RemoteMcpSessionHealth[];
}

/**
 * The live sessions, keyed by server id.
 *
 * In memory and nowhere else. There is no store, no cache and no file: a
 * restart of this container is a full teardown of every outbound session, which
 * is the correct behaviour for the component ADR-043 §4 says the kill switch
 * tears down.
 */
export class BridgeSessionStore {
  readonly #sessions = new Map<string, RemoteMcpSession>();
  readonly #factories: Readonly<Record<string, SessionFactory>>;

  constructor(factories: Readonly<Record<string, SessionFactory>> = SESSION_FACTORIES) {
    this.#factories = factories;
  }

  knows(serverId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#factories, serverId);
  }

  get(serverId: string): RemoteMcpSession | undefined {
    return this.#sessions.get(serverId);
  }

  /**
   * Build, connect and register a session, replacing any existing one.
   *
   * Replacement rather than refusal: the caller re-opens when the customer's
   * credential changed, and a surface that answered "already open" would leave
   * the box authenticated with a credential the operator has revoked. The old
   * session is closed first so the replaced transport is not left dangling.
   */
  async open(serverId: string, input: OpenSessionInput): Promise<RemoteMcpSessionHealth> {
    const factory = this.#factories[serverId];
    if (!factory) throw new Error(`no session factory for "${serverId}"`);
    await this.close(serverId);
    const session = factory(input);
    this.#sessions.set(serverId, session);
    return session.connect();
  }

  async close(serverId: string): Promise<boolean> {
    const session = this.#sessions.get(serverId);
    if (!session) return false;
    this.#sessions.delete(serverId);
    await session.close();
    return true;
  }

  /** Every open session's health, sorted by id. Served by `/health`. */
  healthAll(): RemoteMcpSessionHealth[] {
    return [...this.#sessions.keys()].sort().map((id) => this.#sessions.get(id)!.health());
  }
}

export interface BridgeApiOptions {
  /** The shared secret. Empty means "not provisioned" and every non-`/health`
   *  route answers 503 — see `http-auth.ts`. */
  serviceToken: string;
  store: BridgeSessionStore;
  /** Injected. Receives a method, a path, a status and a server id — never a
   *  request body, never a header. */
  log?: (line: Record<string, unknown>) => void;
}

const noopLog = (): void => undefined;

function err(
  status: number,
  code: BridgeErrorCode,
  message: string,
  state?: RemoteMcpSessionHealth,
): BridgeResponse {
  const body: BridgeErrorBody = { error: { code, message } };
  if (state) body.state = state;
  return { status, body };
}

/** Read a required non-empty string out of an unvalidated body. */
function requiredString(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Read an optional array-of-strings field.
 *
 * Three outcomes, kept distinct on purpose: `undefined` (the key is absent),
 * the array, or the sentinel `"invalid"` for a key that is present and the
 * wrong shape. Collapsing the third into `undefined` would silently drop a
 * malformed baseline and let the session start with no drift detection at all —
 * the failure this field exists to prevent, arriving as a typo.
 */
function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined | "invalid" {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) return "invalid";
  return v as string[];
}

/**
 * Route one request.
 *
 * Order is load-bearing and mirrors `routes/web.ts`: auth first, then
 * validation, then the session. Nothing dials before the bearer check passes.
 */
export async function handleBridgeRequest(
  req: BridgeRequest,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  const log = opts.log ?? noopLog;
  const res = await route(req, opts);
  log({ method: req.method, path: req.path, status: res.status });
  return res;
}

async function route(
  req: BridgeRequest,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  const auth = checkBridgeBearer(req.path, req.authorization, opts.serviceToken);
  if (!auth.ok) {
    return err(
      auth.status,
      auth.code,
      auth.code === "AUTH_NOT_CONFIGURED"
        ? "mcp-bridge auth is not configured (MCP_BRIDGE_SERVICE_TOKEN unset)."
        : "Unauthorized.",
    );
  }

  if (req.path === "/health") {
    if (req.method !== "GET") {
      return err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on /health.`);
    }
    // A CONSTANT, and deliberately nothing else. This is the one route served
    // without a bearer (`http-auth.ts`), which makes its body readable by every
    // container on the compose bridge network — Nextcloud, Frigate, Redis,
    // mosquitto and any third-party image among them. It answered
    // `knownServerIds()` and `store.healthAll()` until WARP-2300 review, which
    // told an unauthenticated reader which vendors this box knows, whether the
    // customer has connected Atlassian, and from `reason`/`consecutiveFailures`
    // whether their credential is being REJECTED. That is WARP-2111's shape one
    // layer down. The inventory moved to `GET /sessions`, behind the bearer.
    //
    // The compose healthcheck reads the STATUS CODE and discards the body
    // (`docker-compose.yml`: `wget -q -O - … >/dev/null`), so it is unaffected.
    return { status: 200, body: { status: "ok" } };
  }

  const parts = req.path.split("/").filter((p) => p.length > 0);
  if (parts[0] !== "sessions" || parts.length < 1 || parts.length > 3) {
    return err(404, "NOT_FOUND", `No route for ${req.path}.`);
  }

  if (parts.length === 1) {
    // `GET /sessions` — what `/health` used to leak, now behind the bearer the
    // auth check above has already enforced.
    if (req.method !== "GET") {
      return err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    }
    return {
      status: 200,
      body: {
        knownServers: knownServerIds(),
        sessions: opts.store.healthAll(),
      } satisfies BridgeSessionsBody,
    };
  }
  const serverId = parts[1]!;
  const action = parts[2];

  if (!SERVER_ID_PATTERN.test(serverId) || !opts.store.knows(serverId)) {
    // Explicit refusal rather than a 404 shrug: this is the ONE place a
    // caller's server id meets the id this component actually implements, so a
    // mismatch between the orchestrator's constant and the bridge's has to be
    // visible here instead of presenting as an empty tool list.
    return err(
      404,
      "UNKNOWN_SERVER_ID",
      `"${serverId}" is not a server this bridge implements. Known: ${knownServerIds().join(", ")}.`,
    );
  }

  if (action === undefined) {
    if (req.method !== "DELETE") {
      return err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    }
    const closed = await opts.store.close(serverId);
    return { status: 200, body: { closed } };
  }

  switch (action) {
    case "open":
      return req.method === "POST"
        ? openSession(serverId, req.body, opts)
        : err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    case "tools":
      return req.method === "GET"
        ? listTools(serverId, opts)
        : err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    case "call":
      return req.method === "POST"
        ? callTool(serverId, req.body, opts)
        : err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    case "state":
      return req.method === "GET"
        ? sessionState(serverId, opts)
        : err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    case "acknowledge-catalog":
      return req.method === "POST"
        ? acknowledgeCatalog(serverId, opts)
        : err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    default:
      return err(404, "NOT_FOUND", `No route for ${req.path}.`);
  }
}

async function openSession(
  serverId: string,
  rawBody: unknown,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return err(400, "INVALID_REQUEST", "Body must be a JSON object.");
  }
  const body = rawBody as Record<string, unknown>;
  const email = requiredString(body, "email");
  const apiToken = requiredString(body, "apiToken");
  const cloudId = requiredString(body, "cloudId");
  if (!email || !apiToken || !cloudId) {
    // Names the MISSING FIELD, never a value — a message that echoed the body
    // back would put the credential in the orchestrator's log the first time
    // somebody mistyped a key.
    const missing = [
      email ? null : "email",
      apiToken ? null : "apiToken",
      cloudId ? null : "cloudId",
    ].filter((f): f is string => f !== null);
    return err(400, "INVALID_REQUEST", `Missing or empty: ${missing.join(", ")}.`);
  }
  const url = requiredString(body, "url");
  // WARP-2651 — the caller's vetted catalog, carried across a restart of THIS
  // container. Validated to the same shape a tool name can have rather than
  // trusted: it is the one field of this body that comes back out of the
  // component (as `catalog_changed` drift), and an entry that is not a string
  // would make the new session's baseline disagree with the listing it is
  // compared against. Absent stays absent — `[]` would claim the caller vetted
  // an empty surface, which is a different and wrong statement.
  const knownTools = optionalStringArray(body, "knownTools");
  if (knownTools === "invalid") {
    return err(400, "INVALID_REQUEST", "knownTools must be an array of strings.");
  }
  try {
    const state = await opts.store.open(serverId, {
      email,
      apiToken,
      cloudId,
      ...(url ? { url } : {}),
      ...(knownTools !== undefined ? { knownTools } : {}),
    });
    return { status: 200, body: { state } satisfies BridgeStateBody };
  } catch (e) {
    // `connect()` classifies its own failures into the session state and does
    // NOT throw; anything that lands here is a construction-time refusal —
    // `assertSafeMcpUrl` rejecting a host, or an empty cloudId. Both are the
    // caller's input, so 400 with our own message, never the vendor's.
    return err(400, "INVALID_REQUEST", messageOf(e));
  }
}

async function listTools(
  serverId: string,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  const session = opts.store.get(serverId);
  if (!session) return notOpen(serverId);
  try {
    const tools = await session.listTools();
    return { status: 200, body: { tools, state: session.health() } satisfies BridgeToolsBody };
  } catch (e) {
    return fromSessionError(e, session);
  }
}

async function callTool(
  serverId: string,
  rawBody: unknown,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  const session = opts.store.get(serverId);
  if (!session) return notOpen(serverId);
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return err(400, "INVALID_REQUEST", "Body must be a JSON object.", session.health());
  }
  const body = rawBody as Record<string, unknown>;
  const name = requiredString(body, "name");
  if (!name) {
    return err(400, "INVALID_REQUEST", "Missing or empty: name.", session.health());
  }
  const rawArgs = body.args;
  if (
    rawArgs !== undefined &&
    (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))
  ) {
    return err(400, "INVALID_REQUEST", "args must be a JSON object.", session.health());
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    const result = await session.callTool(name, args);
    return { status: 200, body: { result, state: session.health() } satisfies BridgeCallBody };
  } catch (e) {
    return fromSessionError(e, session);
  }
}

function sessionState(serverId: string, opts: BridgeApiOptions): BridgeResponse {
  const session = opts.store.get(serverId);
  if (!session) return notOpen(serverId);
  return { status: 200, body: { state: session.health() } satisfies BridgeStateBody };
}

function acknowledgeCatalog(serverId: string, opts: BridgeApiOptions): BridgeResponse {
  const session = opts.store.get(serverId);
  if (!session) return notOpen(serverId);
  return { status: 200, body: { state: session.acknowledgeCatalog() } satisfies BridgeStateBody };
}

/**
 * "No session is open" is its OWN code, distinct from "the session is open and
 * not ready". They read the same from the outside — no tools, no calls — and
 * mean opposite things: one needs the orchestrator to open a session, the other
 * needs the customer to fix a credential or the network to come back.
 */
function notOpen(serverId: string): BridgeResponse {
  return err(
    409,
    "SESSION_NOT_OPEN",
    `No session is open for "${serverId}". POST /sessions/${serverId}/open first.`,
  );
}

/**
 * Turn a thrown session error into a wire refusal.
 *
 * A `RemoteMcpSessionNotReadyError` is a STATE, so it answers 409 with the
 * health attached; anything else is an upstream failure and answers 502. Both
 * carry the health, because ADR-043 §1 forbids a degraded read rendering as a
 * complete one and a caller cannot honour that with a bare status code.
 */
function fromSessionError(e: unknown, session: RemoteMcpSession): BridgeResponse {
  const state = session.health();
  const code = codeOf(e);
  if (code === "REMOTE_MCP_SESSION_NOT_READY") {
    return err(409, "SESSION_NOT_READY", messageOf(e), state);
  }
  return err(502, "REMOTE_CALL_FAILED", messageOf(e), state);
}

function codeOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/**
 * The message we are willing to forward.
 *
 * Every error this component raises deliberately (`TruncatedResultError`,
 * `AtlassianStructuredContentUnavailableError`, `UnsafeMcpUrlError`,
 * `ProtocolVersionMismatchError`, `RemoteMcpSessionNotReadyError`) carries a
 * `code` and a message WE wrote, and those are the useful ones. An error with
 * no code is the SDK's or the transport's: its text is the counterparty's, so
 * it is replaced rather than relayed — a vendor's error body must not reach a
 * model through an audit row (`session-state.ts`: classification is by shape,
 * never by text).
 */
function messageOf(e: unknown): string {
  if (codeOf(e) !== null && e instanceof Error) return e.message;
  return "The remote MCP call failed. See the session state for the classified reason.";
}
