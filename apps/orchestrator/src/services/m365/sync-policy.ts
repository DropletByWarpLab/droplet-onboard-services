/**
 * WARP-2118 / ADR-041 — the pure decisions inside the Graph sync engine.
 *
 * The box has no inbound path and never will, so Graph change-notification
 * subscriptions — which require a publicly reachable HTTPS endpoint — are not
 * available to us. Delta-query polling is therefore the sync mechanism **by
 * design**, which ADR-041 records as an architectural choice rather than a
 * limitation. Microsoft built delta query for exactly this shape, and the
 * budget is generous: Outlook allows 10,000 requests per 10 minutes per
 * mailbox, so a one-minute poll across ten folders spends about 1% of it.
 *
 * Everything here is pure — no I/O, no clock of its own, no randomness that
 * isn't injectable — because these are the decisions that fail quietly on a
 * customer's box weeks after they ship.
 */

/** What went wrong, and therefore what to do about it. */
export type SyncFailureKind =
  /** A wobble. Back off and retry the same cursor. */
  | "TRANSIENT"
  /** The delta token is dead. Drop it and re-enumerate from scratch. */
  | "RESYNC_REQUIRED"
  /** The grant is dead. Repair the CONNECTION, not this cursor. */
  | "AUTH"
  /** Genuinely broken. Stop; retrying just hammers Microsoft. */
  | "FATAL";

/** The error shape Graph clients surface, normalised. */
export interface SyncFailureLike {
  statusCode?: number;
  /** Graph's `error.code`, or a Node network errno. */
  code?: string;
  message?: string;
}

/**
 * Graph error codes meaning "your delta token can no longer be honoured".
 *
 * Outlook keeps delta tokens in an internal cache with **no fixed lifetime**
 * and evicts old ones, so this is expected on any long-lived connection rather
 * than exceptional. Drive splits the same idea into two flavours; both mean
 * re-enumerate, and the distinction only matters to a client that also uploads.
 */
const RESYNC_CODES: ReadonlySet<string> = new Set([
  "syncStateNotFound",
  "resyncRequired",
  "resyncChangesApplyDifferences",
  "resyncChangesUploadDifferences",
]);

/** Node-level transport errnos. No OAuth meaning; purely "the network failed". */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
]);

/**
 * Decide how to recover from a failed delta call.
 *
 * `AUTH` is deliberately distinct from `FATAL`: a dead grant is a property of
 * the **connection**, not of one cursor. Marking the cursor failed would leave
 * every other cursor for that person retrying against the same dead token,
 * turning one reconnect into a storm of pointless calls.
 */
export function classifySyncFailure(err: SyncFailureLike): SyncFailureKind {
  const code = (err.code ?? "").trim();
  const status = err.statusCode;

  if (code && RESYNC_CODES.has(code)) return "RESYNC_REQUIRED";
  if (status === 410) return "RESYNC_REQUIRED";

  if (code && TRANSIENT_CODES.has(code)) return "TRANSIENT";
  if (status === 429) return "TRANSIENT";
  if (typeof status === "number" && status >= 500 && status <= 599) return "TRANSIENT";

  if (status === 401 || status === 403) return "AUTH";

  return "FATAL";
}

// --- Backoff --------------------------------------------------------------

/** Ceiling on a single wait. Long enough to stop hammering, short enough that
 *  a recovered connection resumes within the hour rather than the day. */
export const MAX_BACKOFF_MS = 30 * 60 * 1000;

/** First retry delay, before exponential growth and jitter. */
const BASE_BACKOFF_MS = 30 * 1000;

/**
 * Read a `Retry-After` header into milliseconds.
 *
 * Supports both forms the RFC allows: delta-seconds and an HTTP-date. Returns
 * null when absent or unparseable, which is the caller's cue to fall back to
 * exponential backoff rather than to retry immediately.
 */
export function parseRetryAfter(
  header: string | undefined | null,
  now: Date = new Date(),
): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  // A date already in the past means "retry now", not "retry in the past".
  return Math.max(0, when - now.getTime());
}

/**
 * How long to wait before retrying a cursor.
 *
 * **`Retry-After` is obeyed exactly when Microsoft sends one.** It is not a
 * suggestion: throttled requests still count against the tenant's budget, so
 * retrying early actively deepens the throttling it is trying to escape.
 *
 * Otherwise: exponential growth from a 30s base, capped, with jitter. The
 * jitter matters more than it looks — without it every workload for every
 * connected person wakes at the same instant, and one throttle becomes a
 * synchronised stampede that re-throttles the box immediately.
 *
 * `random` is injectable so the jitter is testable.
 */
export function computeBackoffMs(
  consecutiveFailures: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) return retryAfterMs;

  const attempt = Math.max(1, consecutiveFailures);
  // Cap the exponent before multiplying so a long-dead cursor cannot overflow.
  const growth = Math.min(2 ** Math.min(attempt - 1, 10), MAX_BACKOFF_MS / BASE_BACKOFF_MS);
  const base = Math.min(BASE_BACKOFF_MS * growth, MAX_BACKOFF_MS);

  // Full jitter over the top 50%: keeps a floor (so we always wait something)
  // while spreading retries across a wide enough window to break lockstep.
  const jittered = base * 0.5 + base * 0.5 * random();
  return Math.max(1, Math.min(Math.round(jittered), MAX_BACKOFF_MS));
}

// --- Delta links ----------------------------------------------------------

export interface DeltaLinks {
  /** Present on the LAST page of a run: the token for the next sync. */
  deltaLink: string | null;
  /** Present mid-run: fetch this to continue the current page sequence. */
  nextLink: string | null;
}

/**
 * Pull the continuation links out of a delta response.
 *
 * Both are stored and replayed **whole and opaque**. The deltaLink encodes
 * `$select` and other request state, so rebuilding it by hand silently changes
 * what the next sync asks Microsoft for — a bug that looks like missing data
 * rather than like a malformed URL.
 */
export function extractDeltaLinks(page: Record<string, unknown>): DeltaLinks {
  const deltaLink = typeof page["@odata.deltaLink"] === "string"
    ? (page["@odata.deltaLink"] as string)
    : null;
  const nextLink = typeof page["@odata.nextLink"] === "string"
    ? (page["@odata.nextLink"] as string)
    : null;
  return { deltaLink, nextLink };
}

// --- Identification -------------------------------------------------------

/**
 * The User-Agent Microsoft asks integrators to send.
 *
 * Beyond politeness: when a tenant is being throttled, this is what lets
 * Microsoft support (and the customer's own admin) tell which application is
 * responsible instead of guessing.
 */
export function graphUserAgent(version: string): string {
  return `ISV|WarpLab|Droplet/${version}`;
}
