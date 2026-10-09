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
import type { OAuthDeps } from "./oauth/http.js";
import { handleOAuthRoute } from "./oauth/routes.js";
import {
  RemoteMcpSession,
  type RemoteToolCallOutcome,
  type RemoteToolDescriptor,
} from "./remote-session.js";
import type { RemoteMcpSessionHealth } from "./session-state.js";
import {
  SESSION_PROFILES,
  toSessionProfile,
  type OpenSessionInput,
  type SessionFactory,
  type SessionProfile,
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
  | "NO_SESSION"
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
  /** WARP-2409 — member-connection sessions held per server: a count, never an id or a member. */
  connectionSessions: Record<string, number>;
}

/** WARP-2409 — a member connection id is a UUID (McpOAuthConnection.id). */
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isConnectionId(v: unknown): v is string {
  return typeof v === "string" && CONNECTION_ID_PATTERN.test(v);
}
/** Member sessions one server may hold at once (fail closed past it). */
export const MAX_CONNECTION_SESSIONS = 256;
const CONNECTION_IDLE_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

/** The body's optional `connectionId`: undefined when absent, null when present
 *  and not a UUID (the caller refuses), else the id. */
function connectionIdOf(body: unknown): string | undefined | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const v = (body as Record<string, unknown>).connectionId;
  if (v === undefined) return undefined;
  return isConnectionId(v) ? v : null;
}

/** `<serverId>#<connectionId>` for a member session, else the bare server id. */
function killSwitchError(): Error {
  return Object.assign(new Error("the session was closed by the kill switch while it was opening."), {
    code: "SESSION_CLOSED_BY_KILL_SWITCH",
  });
}

function keyOf(serverId: string, connectionId?: string): string {
  return connectionId ? `${serverId}#${connectionId}` : serverId;
}

/**
 * The live sessions, keyed by server id (or `server#connection` for a member's
 * own OAuth session, WARP-2409).
 *
 * In memory and nowhere else. There is no store, no cache and no file: a
 * restart of this container is a full teardown of every outbound session, which
 * is the correct behaviour for the component ADR-043 §4 says the kill switch
 * tears down.
 */
export class BridgeSessionStore {
  readonly #sessions = new Map<string, RemoteMcpSession>();
  readonly #profiles: ReadonlyMap<string, SessionProfile>;

  /**
   * WARP-3703 — a registry of PROFILES, each the factory plus the fields the
   * wire must carry for it. A bare {@link SessionFactory} is still accepted for
   * an entry (every harness written before profiles passes one) and is held to
   * the contract factories had then — see `toSessionProfile`.
   */
  constructor(
    registry: Readonly<Record<string, SessionProfile | SessionFactory>> = SESSION_PROFILES,
    options: { idleMs?: number; now?: () => number } = {},
  ) {
    this.#idleMs = options.idleMs ?? CONNECTION_IDLE_MS;
    this.#now = options.now ?? Date.now;
    this.#profiles = new Map(
      Object.entries(registry).map(
        ([id, entry]): [string, SessionProfile] => [id, toSessionProfile(entry)],
      ),
    );
  }

  knows(serverId: string): boolean {
    return this.#profiles.has(serverId);
  }

  /** The ids THIS store serves, sorted — the registry it was built with, not
   *  the process-wide one, so a refusal never names a server it cannot open. */
  knownServerIds(): string[] {
    return [...this.#profiles.keys()].sort();
  }

  /**
   * The flat fields `POST /sessions/:id/open` must carry for this server.
   *
   * Throws for an id the store does not serve rather than answering "none": an
   * empty contract is the one answer that would let an unvalidated body reach a
   * factory. The route asks only after {@link knows} has said yes.
   */
  requiredFieldsOf(serverId: string): readonly string[] {
    const profile = this.#profiles.get(serverId);
    if (!profile) throw new Error(`no session factory for "${serverId}"`);
    return profile.requiredFields;
  }

  /** WARP-2409 — the alternative field sets `open` accepts (one for a profile
   *  that declares none). */
  fieldSetsOf(serverId: string): readonly (readonly string[])[] {
    const profile = this.#profiles.get(serverId);
    if (!profile) throw new Error(`no session factory for "${serverId}"`);
    return profile.requiredFieldSets ?? [profile.requiredFields];
  }

  /** The session for a server, or for one member connection of it. */
  get(serverId: string, connectionId?: string): RemoteMcpSession | undefined {
    const key = keyOf(serverId, connectionId);
    const session = this.#sessions.get(key);
    if (session && connectionId) this.#lastUsed.set(key, this.#now());
    return session;
  }

  /** How many member-connection sessions each server holds. Counts only: no
   *  connection id, no member ever leaves this process. */
  connectionSessionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of this.#sessions.keys()) {
      const at = key.indexOf("#");
      if (at !== -1) out[key.slice(0, at)] = (out[key.slice(0, at)] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Build, connect and register a session, replacing any existing one.
   *
   * Replacement rather than refusal: the caller re-opens when the customer's
   * credential changed, and a surface that answered "already open" would leave
   * the box authenticated with a credential the operator has revoked. The old
   * session is closed first so the replaced transport is not left dangling.
   *
   * WARP-2744: serialized per server id. A second concurrent open for the same
   * id waits for the first to finish and then REPLACES it, rather than
   * coalescing into it — see {@link BridgeSessionStore.#serialize} for the race,
   * and the paragraph above for why the last caller's credential has to win.
   */
  async open(
    serverId: string,
    input: OpenSessionInput,
    connectionId?: string,
  ): Promise<RemoteMcpSessionHealth> {
    const key = keyOf(serverId, connectionId);
    // Read synchronously on entry, before waiting on the chain (kill switch).
    const gen = this.#generationOf(serverId);
    return this.#serialize(key, async () => {
      const profile = this.#profiles.get(serverId);
      if (!profile) throw new Error(`no session factory for "${serverId}"`);
      await this.#closeNow(key);
      if (gen !== this.#generationOf(serverId)) throw killSwitchError();
      if (connectionId) {
        // Bounded: a replacement frees its own slot first (above), so only a
        // genuinely new connection can hit the cap.
        const held = this.connectionSessionCounts()[serverId] ?? 0;
        if (held >= MAX_CONNECTION_SESSIONS) {
          throw Object.assign(new Error("too many member sessions are open for this server."), {
            code: "TOO_MANY_SESSIONS",
          });
        }
      }
      const session = profile.factory(input);
      this.#sessions.set(key, session);
      if (connectionId) {
        this.#lastUsed.set(key, this.#now());
        this.#armSweep();
      }
      const health = await session.connect();
      // Re-checked after the dial: a kill switch that ran while we connected
      // wins, so no session outlives it.
      if (gen !== this.#generationOf(serverId)) {
        if (this.#sessions.get(key) === session) {
          this.#sessions.delete(key);
          this.#lastUsed.delete(key);
        }
        await session.close();
        throw killSwitchError();
      }
      return health;
    });
  }

  async close(serverId: string, connectionId?: string): Promise<boolean> {
    const key = keyOf(serverId, connectionId);
    return this.#serialize(key, () => this.#closeNow(key));
  }

  /**
   * The kill switch (ADR-043 section 4): the server's base session AND every
   * member-connection session of it. Includes opens still in flight (their
   * chain is queued behind), so a session mid-connect cannot survive.
   */
  async closeAll(serverId: string): Promise<boolean> {
    // Synchronously, BEFORE the snapshot: an open that began earlier is
    // refused at its next checkpoint; one that begins later is a new event.
    this.#generation.set(serverId, this.#generationOf(serverId) + 1);
    const ours = (k: string) => k === serverId || k.startsWith(`${serverId}#`);
    const keys = new Set([...this.#sessions.keys(), ...this.#chains.keys()].filter(ours));
    const results = await Promise.all([...keys].map((k) => this.#serialize(k, () => this.#closeNow(k))));
    return results.some(Boolean);
  }

  /** Kill-switch generation per server: `closeAll` bumps it; an `open` that
   *  began before the bump refuses to create or keep a session. */
  readonly #generation = new Map<string, number>();
  #generationOf(serverId: string): number {
    return this.#generation.get(serverId) ?? 0;
  }

  readonly #lastUsed = new Map<string, number>();
  readonly #now: () => number;
  readonly #idleMs: number;
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;

  // ponytail: one self-rearming timer for all connection sessions, scanning a
  // map; fine for a few hundred members. Upgrade to an LRU if the cap rises.
  #armSweep(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined;
      void this.#evictIdle();
    }, SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref?.();
  }

  async #evictIdle(): Promise<void> {
    try {
      const cutoff = this.#now() - this.#idleMs;
      for (const [key, used] of [...this.#lastUsed]) {
        if (used > cutoff) continue;
        // Re-checked under the key's lock: a call that touched it meanwhile wins.
        await this.#serialize(key, async () => {
          if ((this.#lastUsed.get(key) ?? 0) <= cutoff) await this.#closeNow(key);
        });
      }
    } catch {
      /* a close that threw has already dropped the session from the map */
    } finally {
      if (this.#lastUsed.size > 0) this.#armSweep();
    }
  }

  /**
   * The close body, WITHOUT the lock.
   *
   * `open()` calls this while it HOLDS the id's chain; routing that call
   * through the public `close()` would make it queue behind itself and never
   * resolve.
   */
  async #closeNow(serverId: string): Promise<boolean> {
    const session = this.#sessions.get(serverId);
    this.#lastUsed.delete(serverId);
    if (!session) return false;
    this.#sessions.delete(serverId);
    await session.close();
    return true;
  }

  /**
   * WARP-2744 — one promise chain per server id, so `open` and `close` cannot
   * interleave on the same session.
   *
   * WHY: both operations `await` BEFORE they write to `#sessions`. Two
   * concurrent `POST /sessions/<id>/open` — a client retry after a slow
   * response is enough — therefore both ran the `close()` at the top of
   * `open()` while the map was still empty, both built a session, and both
   * `set()` the same key. The map keeps the last writer, so the LOSER's session
   * stays connected, holding the vendor `Authorization` header, but untracked:
   * `DELETE /sessions/<id>` and `healthAll()` cannot see it, and nothing else
   * holds a reference that could close it. ADR-043 §4 is explicit that flipping
   * the channel off "tears down live sessions" — a transport no map entry
   * points at survives the kill switch until the container restarts, which is
   * exactly the property §4 says a kill switch must not have. The mirror image
   * is a `close()` landing in that same window: it found an empty map, answered
   * `false`, and the open that followed it registered a session the operator
   * had already killed.
   *
   * A chain and not a flag: `open()` dials, so it is slow, and a caller that
   * was refused with "busy" would just retry into the same race. Per id and not
   * one global lock: two vendors have no reason to queue behind each other, and
   * a global lock would let one unreachable host stall every other session's
   * teardown.
   */
  readonly #chains = new Map<string, Promise<void>>();

  #serialize<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#chains.get(serverId) ?? Promise.resolve();
    // `then(work, work)` rather than `then(work)`: a predecessor that REJECTED
    // (the factory refusing an unsafe URL) must not wedge the id for the life
    // of the process. The chain copy below swallows the outcome so the tail is
    // always resolvable; `run` keeps the rejection for this caller.
    const run = prior.then(work, work);
    const tail: Promise<void> = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        // Released in a `finally`, and only by the CURRENT tail: a caller that
        // has already chained onto this promise replaced the entry, and
        // deleting it here would drop that caller out of the queue.
        if (this.#chains.get(serverId) === tail) this.#chains.delete(serverId);
      });
    this.#chains.set(serverId, tail);
    return run;
  }

  /** Every server-level session's health, sorted by id. Member-connection
   *  sessions are counted by {@link connectionSessionCounts}, not listed. */
  healthAll(): RemoteMcpSessionHealth[] {
    return [...this.#sessions.keys()]
      .filter((k) => !k.includes("#"))
      .sort()
      .map((id) => this.#sessions.get(id)!.health());
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
  /** Test seams of the pinned fetch for the `/oauth/*` hops (WARP-2401). */
  oauthDeps?: OAuthDeps;
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
  // WARP-2401 — web sign-in hops. Bearer-checked above; the body is never logged.
  if (parts[0] === "oauth" && parts.length <= 2) {
    return handleOAuthRoute(parts[1], req.method, req.body, opts.oauthDeps);
  }
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
        knownServers: opts.store.knownServerIds(),
        sessions: opts.store.healthAll(),
        connectionSessions: opts.store.connectionSessionCounts(),
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
      `"${serverId}" is not a server this bridge implements. Known: ${opts.store.knownServerIds().join(", ")}.`,
    );
  }

  if (action === undefined) {
    if (req.method !== "DELETE") {
      return err(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on ${req.path}.`);
    }
    const closed = await opts.store.closeAll(serverId);
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
    case "close":
      return req.method === "POST"
        ? closeConnection(serverId, req.body, opts)
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
  // WARP-3703 — the contract is the PROFILE's, not one every server shares: a
  // vendor that presents a single Bearer token has no email and no site. Only
  // the fields the profile names are read, and only those are forwarded, so an
  // Atlassian-shaped body sent to a bearer-only vendor hands its factory
  // nothing it did not ask for.
  // WARP-2409 — a profile may accept alternative field sets (API token, or a
  // member's bearer). The body must complete exactly one and carry nothing of
  // the others; a partial or mixed body is refused, naming the FIELD.
  const sets = opts.store.fieldSetsOf(serverId);
  const present = (n: string) => requiredString(body, n) !== null;
  const chosen =
    sets.find((s) => s.every(present)) ??
    // None complete: report against the set the caller came closest to
    // (first on a tie), so the message names what to add.
    sets.reduce((best, s) => (s.filter(present).length > best.filter(present).length ? s : best));
  const missing = chosen.filter((n) => !present(n));
  if (missing.length > 0) {
    // Names the MISSING FIELD, never a value — a message that echoed the body
    // back would put the credential in the orchestrator's log the first time
    // somebody mistyped a key.
    return err(400, "INVALID_REQUEST", `Missing or empty: ${missing.join(", ")}.`);
  }
  const foreign = sets.flat().filter((n) => !chosen.includes(n) && body[n] !== undefined);
  if (foreign.length > 0) {
    return err(400, "INVALID_REQUEST", `Not allowed with this credential: ${[...new Set(foreign)].join(", ")}.`);
  }
  const fields: Record<string, string> = {};
  for (const name of chosen) fields[name] = requiredString(body, name)!;
  const connectionId = connectionIdOf(body);
  if (connectionId === null) {
    return err(400, "INVALID_REQUEST", "connectionId must be a UUID.");
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
    const state = await opts.store.open(
      serverId,
      {
        ...fields,
        ...(url ? { url } : {}),
        ...(knownTools !== undefined ? { knownTools } : {}),
      },
      connectionId,
    );
    return { status: 200, body: { state } satisfies BridgeStateBody };
  } catch (e) {
    if (codeOf(e) === "SESSION_CLOSED_BY_KILL_SWITCH") return err(409, "SESSION_NOT_OPEN", messageOf(e));
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
  // WARP-2409 — a member's own session, when the body names one. A malformed id
  // is refused; an id with no session is NO_SESSION, never a fall back to the
  // server-level session (that would run the call as a different principal).
  const rawConnection = connectionIdOf(rawBody);
  if (rawConnection === null) {
    return err(400, "INVALID_REQUEST", "connectionId must be a UUID.");
  }
  const session = opts.store.get(serverId, rawConnection);
  if (!session) {
    return rawConnection
      ? err(409, "NO_SESSION", `No session is open for that connection. POST /sessions/${serverId}/open with it first.`)
      : notOpen(serverId);
  }
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

/** `POST /sessions/:id/close { connectionId }` — one member's session only. The
 *  id is required, so this can never be mistaken for the kill switch. */
async function closeConnection(
  serverId: string,
  rawBody: unknown,
  opts: BridgeApiOptions,
): Promise<BridgeResponse> {
  const id =
    typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>).connectionId
      : undefined;
  if (!isConnectionId(id)) return err(400, "INVALID_REQUEST", "connectionId must be a UUID.");
  return { status: 200, body: { closed: await opts.store.close(serverId, id) } };
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
