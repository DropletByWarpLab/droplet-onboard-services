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
 * reachable", imported by both routes/storage.ts and
 * services/hostapd-bridge.service.ts (previously a verbatim copy in each).
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
