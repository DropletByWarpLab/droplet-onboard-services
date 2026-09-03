/**
 * WARP-2398 — one outbound MCP session: lifecycle, reconnect, health, and the
 * failure states that make a refusal legible instead of empty.
 *
 * ## Where this runs, and why not in the orchestrator
 *
 * ADR-043 §5: *"The orchestrator process MUST NOT open a session to a remote
 * MCP server."* The orchestrator is the process with the most reach in the
 * box — the database, the tool registry, every internal service — and a
 * remote MCP server sends us tool definitions, tool results and error text
 * that all flow toward a model that acts on them. So the socket lives in this
 * component, shaped after `services/web-fetch` (gate → audit, one component
 * owning outbound), and the orchestrator reaches it through the
 * `McpClientPort` seam.
 *
 * This module is the session core. The HTTP surface that fronts it, its
 * Dockerfile and its compose wiring land with the first real server
 * (WARP-2316) — there is nothing for a listener to serve until a server is
 * registered, and standing up a container that dials nothing would be a
 * service to health-check for no behaviour.
 *
 * ## No scheduling loop
 *
 * Reconnection is EVENT-DRIVEN: the transport tells us it closed, we classify,
 * and if the classification is retryable we schedule exactly one attempt.
 * There is no `while (true)`, no poll and no ticker — the repo rule bans
 * scheduling loops, and a session that re-dials on a timer would keep dialling
 * a host whose credential was revoked. A periodic health *read* belongs to the
 * orchestrator's `cron-runtime.service.ts`, over the port, and reads
 * {@link RemoteMcpSession.health} which is pure.
 *
 * ## Rule 19
 *
 * The credential is a {@link RemoteMcpCredential} closure. This module never
 * reads it, never stores its material, and never puts a server's response
 * text into a health payload — {@link RemoteMcpSessionHealth.reason} is drawn
 * from a fixed vocabulary derived from error *shape*.
 */
import type { RemoteMcpCredential } from "./credentials.js";
import { noCredential } from "./credentials.js";
import {
  classifyRemoteMcpError,
  NON_DISPATCHABLE_STATES,
  type RemoteMcpFailureReason,
  type RemoteMcpSessionHealth,
  type RemoteMcpSessionState,
} from "./session-state.js";

/** One tool as a remote server advertises it. `annotations` is absent by
 *  construction — ADR-043 §2 forbids reading it, so it is never carried. */
export interface RemoteToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

export interface RemoteToolCallOutcome {
  content: { type: string; text?: string }[];
  isError: boolean;
  /**
   * The tool's structured half, when the server sent one.
   *
   * WARP-2316: carried because two Atlassian guards need to read it —
   * `truncation.ts` reads a page's `remainingCount` out of it, and
   * `atlassian.ts` treats its ABSENCE on a tool that should have it as the
   * legible form of upstream #213. `undefined` therefore means "the server
   * sent none", an explicit fact, and is never conflated with an empty object.
   *
   * Unlike `annotations` (dropped at the copy, ADR-043 §2) this is DATA, not a
   * privilege claim: nothing reads it to decide whether a tool may run.
   */
  structuredContent?: unknown;
}

/**
 * The transport-agnostic connection this session drives. Injected, so every
 * test in this workspace runs against a double and no test opens a socket
 * (ADR-043 §1: nothing here dials a host that is not registered, and nothing
 * in CI dials at all).
 */
export interface RemoteMcpConnection {
  listTools(): Promise<RemoteToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<RemoteToolCallOutcome>;
  close(): Promise<void>;
  /** Called by the transport when it drops. `err` is undefined for a clean
   *  server-side close. */
  onClosed(handler: (err?: unknown) => void): void;
}

export interface RemoteMcpConnectInput {
  serverId: string;
  /** Already screened by `assertSafeMcpUrl` — this factory does not re-screen. */
  url: string;
  /** Merged into the transport's request headers. Built per call. */
  headers: Record<string, string>;
  /** Resume an existing MCP session id, when the caller has one. */
  sessionId?: string;
}

export type RemoteMcpConnectionFactory = (
  input: RemoteMcpConnectInput,
) => Promise<RemoteMcpConnection>;

export interface RemoteMcpSessionOptions {
  serverId: string;
  /** MUST already have passed `assertSafeMcpUrl`. */
  url: string;
  connect: RemoteMcpConnectionFactory;
  credential?: RemoteMcpCredential;
  /** Bounded reconnect attempts before the session settles on a failure
   *  state. Default 3 — enough to ride out a blip, few enough that a real
   *  outage becomes visible instead of being retried forever. */
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectDelayGrowthFactor?: number;
  /** Injected so tests drive retries deterministically and nothing sleeps. */
  scheduleRetry?: (delayMs: number, run: () => void) => void;
  /** Injected clock, for the same reason. */
  now?: () => number;
  /**
   * WARP-2651 — the catalog the CALLER has already vetted, so the fourth
   * failure state survives a restart of this container.
   *
   * A session's `catalog_changed` detection compares one `listTools()` against
   * the previous one, and both live in this process's memory. That is correct
   * while the process lives and useless the moment it does not: after a bridge
   * restart the orchestrator re-opens, the first listing has nothing to compare
   * against, and a surface that moved while we were down is absorbed as if it
   * had always looked like that — which is precisely the "a tool that vanished
   * must not surface as 'there is nothing to do'" rule of ADR-043 §1, defeated
   * by a restart rather than by a bug.
   *
   * So the baseline is an INPUT. The orchestrator holds the last catalog it
   * vetted and hands it back on re-open; the first listing then compares
   * against it and flips to `catalog_changed` exactly as an in-process second
   * listing would, blocking dispatch until {@link acknowledgeCatalog}.
   *
   * Absent (the boot case) means "no vetted baseline exists", which is a
   * different fact from an empty one and is why this is optional rather than
   * defaulting to `[]`: an empty array would claim the caller vetted a surface
   * with no tools in it, and every tool the server advertises would read as
   * `added` drift on the first listing of a brand-new box.
   */
  knownToolNames?: readonly string[];
}

const DEFAULTS = {
  maxReconnectAttempts: 3,
  initialReconnectDelayMs: 1_000,
  maxReconnectDelayMs: 30_000,
  reconnectDelayGrowthFactor: 2,
};

function defaultScheduleRetry(delayMs: number, run: () => void): void {
  const t = setTimeout(run, delayMs);
  // Never hold the process open on a pending reconnect.
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
}

/** A tool that disappeared from a server's catalog between two listings. */
export interface CatalogDrift {
  removed: string[];
  added: string[];
}

export class RemoteMcpSession {
  readonly serverId: string;
  readonly url: string;

  #state: RemoteMcpSessionState = "idle";
  #reason: RemoteMcpFailureReason | null = null;
  #connection: RemoteMcpConnection | null = null;
  #catalog: RemoteToolDescriptor[] = [];
  #catalogNames: ReadonlySet<string> = new Set();
  #drift: CatalogDrift | null = null;
  #consecutiveFailures = 0;
  #lastReadyAt: number | null = null;
  #reconnectAttempts = 0;

  readonly #credential: RemoteMcpCredential;
  readonly #connect: RemoteMcpConnectionFactory;
  readonly #scheduleRetry: (delayMs: number, run: () => void) => void;
  readonly #now: () => number;
  readonly #maxReconnectAttempts: number;
  readonly #initialReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #reconnectDelayGrowthFactor: number;

  constructor(opts: RemoteMcpSessionOptions) {
    this.serverId = opts.serverId;
    this.url = opts.url;
    this.#credential = opts.credential ?? noCredential();
    this.#connect = opts.connect;
    this.#scheduleRetry = opts.scheduleRetry ?? defaultScheduleRetry;
    this.#now = opts.now ?? (() => Date.now());
    this.#maxReconnectAttempts =
      opts.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts;
    this.#initialReconnectDelayMs =
      opts.initialReconnectDelayMs ?? DEFAULTS.initialReconnectDelayMs;
    this.#maxReconnectDelayMs =
      opts.maxReconnectDelayMs ?? DEFAULTS.maxReconnectDelayMs;
    this.#reconnectDelayGrowthFactor =
      opts.reconnectDelayGrowthFactor ?? DEFAULTS.reconnectDelayGrowthFactor;
    // WARP-2651: seed the drift baseline, but do NOT seed `#catalog` — the
    // names are what drift is computed from, while `#catalog` is what this
    // session actually served and `health().toolCount` reports. Claiming a tool
    // count for a listing that has not happened would be the same guess the
    // state enum exists to forbid.
    if (opts.knownToolNames !== undefined) {
      this.#catalogNames = new Set(opts.knownToolNames);
    }
  }

  get state(): RemoteMcpSessionState {
    return this.#state;
  }

  /** `true` only in `ready`. Never derived from "we have a connection object"
   *  — a dropped transport leaves the object behind. */
  get isStarted(): boolean {
    return this.#state === "ready";
  }

  /** Pure. Safe to log, safe to serve, carries no credential material. */
  health(): RemoteMcpSessionHealth {
    return {
      serverId: this.serverId,
      state: this.#state,
      toolCount: this.#catalog.length,
      consecutiveFailures: this.#consecutiveFailures,
      lastReadyAt: this.#lastReadyAt,
      reason: this.#reason,
    };
  }

  /** How this session identifies itself in an audit row: the principal, never
   *  the secret. */
  describeCredential(): string {
    return this.#credential.describe();
  }

  /** The drift that put this session in `catalog_changed`, or `null`. */
  catalogDrift(): CatalogDrift | null {
    return this.#drift;
  }

  /**
   * Open the session. Idempotent while `ready`. On failure the session
   * settles on the classified failure state and the error is NOT rethrown as
   * a bare transport error — the caller reads {@link health} and gets a
   * remedy, which is ADR-041's whole point.
   */
  async connect(): Promise<RemoteMcpSessionHealth> {
    if (this.#state === "ready") return this.health();
    if (this.#state === "closed") {
      // A deliberately closed session does not silently re-open: ADR-043 §4's
      // kill switch tears sessions down, and a component that re-dialled
      // afterwards would not be a kill switch.
      return this.health();
    }
    this.#state = "connecting";
    try {
      const connection = await this.#connect({
        serverId: this.serverId,
        url: this.url,
        headers: this.#credential.headers(),
      });
      connection.onClosed((err) => this.#onTransportClosed(err));
      this.#connection = connection;
      this.#state = "ready";
      this.#reason = null;
      this.#consecutiveFailures = 0;
      this.#reconnectAttempts = 0;
      this.#lastReadyAt = this.#now();
    } catch (err) {
      this.#consecutiveFailures += 1;
      this.#connection = null;
      const { state, reason } = classifyRemoteMcpError(err);
      this.#state = state;
      this.#reason = reason;
    }
    return this.health();
  }

  /**
   * The server's tool list.
   *
   * ADR-043 §1's fourth failure state lives here: if a tool present in the
   * previous listing is absent from this one, the session moves to
   * `catalog_changed` and the drift is recorded. Dispatch is blocked in that
   * state until {@link acknowledgeCatalog} — an operator classified specific
   * tools (§2), so a surface that changed under them has to be re-seen rather
   * than absorbed. The new catalog is still RETURNED, because "there is
   * nothing to do" is exactly the rendering the ADR forbids.
   */
  async listTools(): Promise<RemoteToolDescriptor[]> {
    const connection = this.#requireConnection();
    let advertised: RemoteToolDescriptor[];
    try {
      advertised = await connection.listTools();
    } catch (err) {
      this.#failFrom(err);
      throw err;
    }
    const names = new Set(advertised.map((t) => t.name));
    if (this.#catalogNames.size > 0) {
      const removed = [...this.#catalogNames].filter((n) => !names.has(n));
      const added = [...names].filter((n) => !this.#catalogNames.has(n));
      if (removed.length > 0 || added.length > 0) {
        this.#drift = { removed, added };
        this.#state = "catalog_changed";
        this.#reason = "catalog_changed";
      }
    }
    this.#catalog = advertised;
    this.#catalogNames = names;
    return advertised;
  }

  /**
   * Accept the current catalog and return a `catalog_changed` session to
   * `ready`. The caller has re-vetted the surface (namespacing, collisions,
   * classification); this is the explicit acknowledgement that closes the
   * fourth failure state. A no-op in any other state.
   */
  acknowledgeCatalog(): RemoteMcpSessionHealth {
    if (this.#state === "catalog_changed") {
      this.#state = "ready";
      this.#reason = null;
      this.#drift = null;
    }
    return this.health();
  }

  /** Dispatch one tool call. Refused, with the state named, in every
   *  non-dispatchable state. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<RemoteToolCallOutcome> {
    const connection = this.#requireConnection();
    try {
      return await connection.callTool(name, args);
    } catch (err) {
      this.#failFrom(err);
      throw err;
    }
  }

  /**
   * Tear the session down. Terminal: `connect()` will not re-open a closed
   * session (ADR-043 §4 — flipping the channel off must not leave a session
   * that quietly comes back).
   */
  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = null;
    this.#state = "closed";
    this.#reason = null;
    this.#catalog = [];
    this.#catalogNames = new Set();
    this.#drift = null;
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Best-effort: a close that throws must not keep the session open in
        // the caller's model of the world.
      }
    }
  }

  #requireConnection(): RemoteMcpConnection {
    if (NON_DISPATCHABLE_STATES.has(this.#state) || !this.#connection) {
      throw new RemoteMcpSessionNotReadyError(this.serverId, this.#state, this.#reason);
    }
    return this.#connection;
  }

  #failFrom(err: unknown): void {
    const { state, reason } = classifyRemoteMcpError(err);
    this.#state = state;
    this.#reason = reason;
    this.#consecutiveFailures += 1;
  }

  /**
   * The transport dropped. Retry ONCE per drop, on a bounded backoff, and
   * only when the classification says retrying could help: a revoked
   * credential and a protocol mismatch are not fixed by dialling again, and
   * re-dialling them would be an unauthenticated request loop against a
   * vendor.
   */
  #onTransportClosed(err?: unknown): void {
    if (this.#state === "closed") return;
    this.#connection = null;
    const { state, reason } =
      err === undefined
        ? ({ state: "unreachable", reason: "endpoint_unreachable" } as const)
        : classifyRemoteMcpError(err);

    if (state !== "unreachable") {
      this.#state = state;
      this.#reason = reason;
      return;
    }
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#state = "unreachable";
      this.#reason = "retries_exhausted";
      return;
    }
    const delay = Math.min(
      this.#initialReconnectDelayMs *
        this.#reconnectDelayGrowthFactor ** this.#reconnectAttempts,
      this.#maxReconnectDelayMs,
    );
    this.#reconnectAttempts += 1;
    this.#state = "reconnecting";
    this.#reason = null;
    this.#scheduleRetry(delay, () => {
      // `connect()` swallows and classifies; a rejected promise here would be
      // an unhandled rejection on a timer.
      void this.connect();
    });
  }
}

/** Thrown when a call is attempted in a state that cannot serve it. Carries
 *  the state and reason so the caller renders a remedy, never an empty list. */
export class RemoteMcpSessionNotReadyError extends Error {
  readonly code = "REMOTE_MCP_SESSION_NOT_READY";
  constructor(
    readonly serverId: string,
    readonly state: RemoteMcpSessionState,
    readonly reason: RemoteMcpFailureReason | null,
  ) {
    super(
      `remote MCP session "${serverId}" is ${state}` +
        (reason ? ` (${reason})` : "") +
        " — not dispatching",
    );
    this.name = "RemoteMcpSessionNotReadyError";
  }
}
