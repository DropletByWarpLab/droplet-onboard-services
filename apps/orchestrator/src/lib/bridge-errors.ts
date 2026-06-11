/**
 * Shared device-bridge error classification (WARP-808 review #5).
 *
 * The device-bridge only runs with the OLED/display compose profile. On a host
 * without it, a `fetch()` to the bridge fails with a connection error
 * ("fetch failed" + a `cause.code` of ECONNREFUSED/ENOTFOUND/etc.). That's an
 * EXPECTED condition on some deployment shapes — not a fault — so callers
 * degrade cleanly (storage.ts → 200 + `reason: "bridge_unavailable"`;
 * hostapd-bridge.service.ts → RouterError.unreachable for the wizard's soft
 * "finish from Network later" notice) rather than surfacing a 500.
 *
 * Extracted here so the orchestrator has ONE definition of "the bridge wasn't
 * reachable", imported by routes/storage.ts, services/hostapd-bridge.service.ts,
 * and services/reset.service.ts (previously a verbatim copy in each).
 */

/** Socket-level error codes that mean "the bridge couldn't be reached at all". */
const BRIDGE_CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/**
 * True when `err` is a device-bridge *connection* failure (the bridge isn't
 * listening / isn't resolvable), as opposed to a reachable bridge that timed
 * out or returned an error body.
 *
 * Node's undici wraps the socket error in `cause`; older paths put the code
 * directly on the error. We check both.
 */
export function isBridgeConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && BRIDGE_CONNECTION_ERROR_CODES.has(cause.code)) return true;
  const directCode = (err as { code?: string }).code;
  if (directCode && BRIDGE_CONNECTION_ERROR_CODES.has(directCode)) return true;
  return false;
}

/**
 * A fetch/abort failure that means "the request didn't get a response" — a
 * client-side timeout rather than a refused connection.
 * AbortController.abort() throws an AbortError; AbortSignal.timeout() throws a
 * TimeoutError (hostapd-bridge review #6 — checking only AbortError misses the
 * timeout variant). Shared here (pr-reviewer #549, 2026-06-10 finding 2) so
 * every bridge caller classifies timeouts the same way instead of falling
 * through to a generic "operation was aborted" failure.
 */
export function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Shared bridge auth-token resolution for every orchestrator caller that POSTs
 * to the device-bridge (reset.service.ts, hostapd-bridge.service.ts,
 * storage.ts). Centralised here so the security-sensitive env-var precedence
 * chain — BRIDGE_AUTH_TOKEN || SERVICE_TOKEN_DISPLAY, never DEVICE_SECRET_KEY —
 * is defined in one place and all callers stay in lock-step.
 *
 * Per the comment in reset.service.ts (PR #549 review): DEVICE_SECRET_KEY is
 * the FIPS-sealed AES-256 master encryption key. A fallback to it would put the
 * master key in a plaintext HTTP header on a misconfigured install and still 401;
 * failing closed (BRIDGE_AUTH_UNCONFIGURED) keeps it off the wire with a clear
 * remediation path.
 */
export function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}
