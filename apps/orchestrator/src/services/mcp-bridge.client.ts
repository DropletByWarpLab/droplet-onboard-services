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
  ) {
    super(message);
    this.code = code;
    this.name = "McpBridgeError";
  }
}

/** The credential handed to the bridge at open time. Never persisted here,
 *  never logged, never returned — it is read out of the ADR-042 seam, passed
 *  through, and dropped (rule 19). */
export interface McpBridgeOpenInput {
  email: string;
  apiToken: string;
  cloudId: string;
  /** Test-only override; the bridge screens it against its own host set. */
  url?: string;
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

  constructor(opts: McpBridgeClientOptions) {
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
    this.#opened = true;
    return body.state;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const body = await this.#send<{ tools: McpToolDescriptor[] }>(
      "GET",
      `/sessions/${this.serverId}/tools`,
    );
    return body.tools;
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
    }
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.#serviceToken.length === 0) {
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
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#serviceToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
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
      throw new McpBridgeError(
        parsed?.error?.code ?? "REMOTE_CALL_FAILED",
        parsed?.error?.message ?? `mcp-bridge answered ${res.status}.`,
        res.status,
        parsed?.state,
      );
    }
    if (parsed === null) {
      throw new McpBridgeError("REMOTE_CALL_FAILED", "mcp-bridge answered with no JSON body.", res.status);
    }
    return parsed as T;
  }
}
