/**
 * WARP-2398 — the outbound MCP session's state, as an explicit closed union.
 *
 * WHY AN ENUM AND NOT A BOOLEAN. Two repo rules meet here. "No guessing
 * state": persistent status is a declared value, never derived from the
 * absence of something else — a session is not "connected" because a token
 * exists, and it is not "broken" because a tool list came back empty.
 * ADR-041's three-distinct-failure-states rule, inherited unchanged by
 * ADR-043 §1, says the same thing from the other end:
 * `services/erp-connector/src/quickbooks/online-connector.ts` states it as
 * *"None of the three may ever render as an empty result."*
 *
 * The three ADR-041-shaped failures for a session — as opposed to a
 * request — are:
 *
 *   - {@link "auth_rejected"}      the credential is wrong, revoked, or lacks
 *                                  the scope. Remedy: the customer re-issues
 *                                  it. Retrying changes nothing.
 *   - {@link "unreachable"}        DNS, TCP, TLS or timeout. Remedy: wait, or
 *                                  fix the network. Retrying is exactly right.
 *   - {@link "protocol_mismatch"}  we reached an endpoint and it does not
 *                                  speak a protocol version we can. Remedy:
 *                                  an SDK decision (see
 *                                  `docs/mcp-client-sdk-version.md`), not an
 *                                  operator action.
 *
 * ADR-043 §1 adds a FOURTH that has no ADR-041 analogue, because a request
 * has no catalog: {@link "catalog_changed"} — the server is reachable and
 * authenticated, and its tool surface is not the one we vetted. *"A tool that
 * vanished between two `listTools()` calls must not surface as 'there is
 * nothing to do'."*
 */

/** Every state an outbound MCP session can be in. Closed on purpose. */
export const REMOTE_MCP_SESSION_STATES = [
  /** Constructed, never dialled. Not an error; not a session either. */
  "idle",
  /** A connect attempt is in flight. */
  "connecting",
  /** Connected and usable. */
  "ready",
  /** Was ready, the transport dropped, a bounded retry is scheduled. */
  "reconnecting",
  /** Terminal-until-recredentialed: the server refused our credential. */
  "auth_rejected",
  /** The endpoint could not be reached. Retryable. */
  "unreachable",
  /** Reached, but no protocol version in common. */
  "protocol_mismatch",
  /** Reachable and authenticated, but the tool surface changed under us. */
  "catalog_changed",
  /** Closed deliberately — `close()`, or the ADR-043 §4 kill switch. */
  "closed",
] as const;

export type RemoteMcpSessionState = (typeof REMOTE_MCP_SESSION_STATES)[number];

/** The states in which no call may be dispatched. Named rather than derived,
 *  so a new state has to be classified by whoever adds it. */
export const NON_DISPATCHABLE_STATES: ReadonlySet<RemoteMcpSessionState> = new Set([
  "idle",
  "connecting",
  "reconnecting",
  "auth_rejected",
  "unreachable",
  "protocol_mismatch",
  "catalog_changed",
  "closed",
]);

/** The three ADR-041 failure states plus ADR-043 §1's fourth. */
export const FAILURE_STATES: ReadonlySet<RemoteMcpSessionState> = new Set([
  "auth_rejected",
  "unreachable",
  "protocol_mismatch",
  "catalog_changed",
]);

/**
 * Operator-facing health for one session.
 *
 * RULE 19: this object is logged, returned over HTTP and rendered in a
 * dashboard. It carries no credential, no `Authorization` header, and no
 * server response body — only the state, counters and a bounded reason
 * string produced by {@link classifyRemoteMcpError}, which is built from
 * error *shape*, never from error *text*.
 */
export interface RemoteMcpSessionHealth {
  serverId: string;
  state: RemoteMcpSessionState;
  /** Number of tools in the last catalog we accepted. */
  toolCount: number;
  /** Consecutive failed connect attempts since the last `ready`. */
  consecutiveFailures: number;
  /** Epoch ms of the last transition into `ready`, or `null`. */
  lastReadyAt: number | null;
  /** Short machine-readable reason for the current failure state, or `null`
   *  when the state is not a failure. Never free-form server text. */
  reason: RemoteMcpFailureReason | null;
}

/** A bounded vocabulary of failure reasons. Deliberately small — an operator
 *  reads these, and every value maps to a different thing to do. */
export type RemoteMcpFailureReason =
  | "credential_rejected"
  | "credential_missing"
  | "endpoint_unreachable"
  | "endpoint_timeout"
  | "protocol_version_unsupported"
  | "protocol_error"
  | "catalog_changed"
  | "retries_exhausted";

/** The classification of one thrown error into a state + reason. */
export interface RemoteMcpErrorClass {
  state: RemoteMcpSessionState;
  reason: RemoteMcpFailureReason;
}

/**
 * Map a thrown error onto one of the failure states.
 *
 * Classification is by SHAPE first — an HTTP status carried on the error, or
 * a Node `code` — and only falls back to a narrow set of substrings that the
 * SDK and undici produce verbatim. It deliberately never returns the error's
 * message to the caller: a server's error body can contain anything,
 * including material echoed back from our own request headers.
 */
export function classifyRemoteMcpError(err: unknown): RemoteMcpErrorClass {
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) {
    return { state: "auth_rejected", reason: "credential_rejected" };
  }
  // 406/415 are how a Streamable-HTTP endpoint says "not this protocol";
  // 404/405 on the MCP path means the endpoint is not an MCP server at all.
  if (status === 404 || status === 405 || status === 406 || status === 415) {
    return { state: "protocol_mismatch", reason: "protocol_error" };
  }
  if (status !== null && status >= 500) {
    return { state: "unreachable", reason: "endpoint_unreachable" };
  }

  const code = nodeErrorCodeOf(err);
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { state: "unreachable", reason: "endpoint_timeout" };
  }
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return { state: "unreachable", reason: "endpoint_unreachable" };
  }

  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return { state: "unreachable", reason: "endpoint_timeout" };
  }
  if (name === "UnauthorizedError") {
    return { state: "auth_rejected", reason: "credential_rejected" };
  }

  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (message.includes("protocol version")) {
    return { state: "protocol_mismatch", reason: "protocol_version_unsupported" };
  }
  if (message.includes("fetch failed")) {
    return { state: "unreachable", reason: "endpoint_unreachable" };
  }

  // The honest default. An unclassified failure is NOT an auth problem and
  // NOT a protocol problem, and calling it either would send an operator to
  // the wrong remedy. "Unreachable" is the one that says "retry, and if it
  // persists look at the network", which is the correct advice for an error
  // we could not name.
  return { state: "unreachable", reason: "endpoint_unreachable" };
}

function httpStatusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const rec = err as Record<string, unknown>;
  for (const key of ["code", "status", "statusCode"]) {
    const v = rec[key];
    if (typeof v === "number" && v >= 100 && v <= 599) return v;
  }
  return null;
}

function nodeErrorCodeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const rec = err as Record<string, unknown>;
  if (typeof rec.code === "string") return rec.code;
  const cause = rec.cause;
  if (typeof cause === "object" && cause !== null) {
    const c = (cause as Record<string, unknown>).code;
    if (typeof c === "string") return c;
  }
  return null;
}
