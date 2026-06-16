/**
 * Shared "is this backing dependency DOWN / UNREACHABLE / DISABLED?" classifier.
 *
 * A dashboard-polled GET handler that calls an external dependency (Nextcloud,
 * Frigate, the matter-controller sidecar, …) must degrade to an empty payload —
 * not surface an unhandled 500 — when that dependency is simply unavailable. The
 * canonical precedent is models-summary.service.ts → getModelsPagePayload(),
 * which wraps aiGateway.listModels() in try/catch and serves an empty local
 * list on failure so the Models tab still renders during an ai-gateway outage.
 *
 * This module is the ONE definition of "the upstream wasn't reachable" for the
 * read surfaces that don't already have a typed signal (Nextcloud, Frigate and
 * the matter sidecar all throw plain `Error`s — they don't use RouterError).
 * It composes the existing socket-level + timeout classifiers from
 * bridge-errors.ts with the message-shape patterns those HTTP clients produce:
 *
 *   - undici socket failures → `fetch failed` + `cause.code` ∈ {ECONNREFUSED,
 *     ENOTFOUND, EHOSTUNREACH, ENETUNREACH, EAI_AGAIN} (isBridgeConnectionError)
 *     or a bare ETIMEDOUT.
 *   - AbortSignal.timeout() → TimeoutError (isTimeoutOrAbort).
 *   - a reachable-but-5xx upstream → the clients throw
 *     `WebDAV PROPFIND failed: 503`, `Frigate stats: 502`,
 *     `matter-controller returned HTTP 500`, etc.
 *   - explicit "not reachable" prose → `Nextcloud is not reachable: …`,
 *     `Cannot reach Nextcloud OCS API: …`.
 *
 * Real errors — auth (401/403), validation (400), 404, an OCS status — are NOT
 * "unavailable" and must keep their existing typed behavior. Only the
 * unavailable-dependency path degrades.
 */
import { isBridgeConnectionError, isTimeoutOrAbort } from "./bridge-errors.js";

/** Socket-level codes that mean "the dependency couldn't be reached at all".
 *  Superset of bridge-errors' set — adds ETIMEDOUT (a connect timeout reported
 *  as a socket code rather than an AbortSignal TimeoutError). */
const EXTRA_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT"]);

function hasUnavailableCode(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && EXTRA_UNAVAILABLE_CODES.has(cause.code)) return true;
  const directCode = (err as { code?: string }).code;
  if (directCode && EXTRA_UNAVAILABLE_CODES.has(directCode)) return true;
  return false;
}

/**
 * True ONLY when `err` means the backing dependency is down / unreachable /
 * intentionally disabled — never for a real auth / validation / 404 / 4xx
 * error. Used to gate the empty-payload degrade in the dashboard read handlers.
 */
export function isUpstreamUnavailable(err: unknown): boolean {
  // Socket refused/unresolvable (shared bridge classifier) or a connect-timeout
  // socket code, or an AbortSignal.timeout()/AbortError.
  if (isBridgeConnectionError(err)) return true;
  if (hasUnavailableCode(err)) return true;
  if (isTimeoutOrAbort(err)) return true;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  if (!message) return false;

  // undici's top-level "fetch failed" wrapper (the cause-code branch above
  // already catches the classified ones; this covers any variant). Word-
  // bounded so a future wrapper prefix like "prefetch failed: 403" can't
  // masquerade as an outage and degrade a real 4xx.
  if (/\bfetch failed\b/i.test(message)) return true;
  // A reachable upstream that answered 5xx — the HTTP clients fold the status
  // into the message via the same two idioms:
  //   "<label>: 5xx"  → "Frigate stats: 502", "WebDAV PROPFIND failed: 503"
  //   "HTTP 5xx"      → "matter-controller returned HTTP 500"
  // We deliberately do NOT treat 4xx the same way: a 403/404 is a real
  // auth/not-found error the route must keep surfacing, not an outage.
  if (/:\s*5\d\d\b/.test(message) || /\bHTTP\s+5\d\d\b/i.test(message))
    return true;
  // Explicit "service unavailable / not reachable / cannot reach" prose
  // (the 503 HTTP reason phrase + our own "X is not reachable" idioms).
  // Anchored on purpose: a bare /unavailable/ would also swallow per-resource
  // strings like "Preview unavailable" / "Share unavailable", wrongly degrading
  // a real error instead of surfacing it.
  if (/\bservice unavailable\b|\bnot reachable\b|\bcannot reach\b/i.test(message))
    return true;

  return false;
}
