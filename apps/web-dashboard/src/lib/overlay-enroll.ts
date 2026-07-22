/**
 * WARP-1475 — overlay QR-enroll (ADR-030) client helpers.
 *
 * Pure functions shared by the Remote Access page's "Link a device" flow:
 *   - `buildOverlayEnrollUri` — the `droplet://overlay-enroll` deep link the
 *     QR encodes. The Droplet app on the phone parses it, then redeems the
 *     token against the box's `POST /vpn/overlay/devices/by-token`.
 *   - `overlayApproveErrorCopy` — maps the orchestrator's typed approve
 *     failures to honest, customer-safe copy (per ADR-002 tone).
 *
 * Kept token-free of any logging: nothing here ever `console.*`s the token.
 */

/**
 * Build the QR deep link. Every param is percent-encoded via
 * `encodeURIComponent` (so a space becomes `%20`, never `+`, and an injected
 * `&`/`=` in a value can't forge a second query key). The token is base64url
 * — already URL-safe — so encoding is a no-op on it, but we encode uniformly
 * rather than special-case it.
 */
export function buildOverlayEnrollUri(params: {
  server: string;
  token: string;
  boxName: string;
}): string {
  const query =
    `server=${encodeURIComponent(params.server)}` +
    `&token=${encodeURIComponent(params.token)}` +
    `&box_name=${encodeURIComponent(params.boxName)}`;
  return `droplet://overlay-enroll?${query}`;
}

/** An approve failure surfaced by `approveOverlayEnrollment` in lib/api.ts. */
export interface OverlayApproveErrorLike {
  status?: number;
  /** The orchestrator's `body.error` — a short code (409) or a full sentence (503). */
  code?: string;
  message?: string;
}

/**
 * Honest copy for the approve endpoint's typed failures. Each known 409 code
 * gets purpose-written copy; the 503 vouch-retry carries the orchestrator's
 * own already-customer-safe sentence verbatim; anything unmapped falls back to
 * a calm generic — never a raw code, never "something went wrong".
 */
export function overlayApproveErrorCopy(err: OverlayApproveErrorLike): string {
  const KNOWN: Record<string, string> = {
    already_being_approved:
      "This device is already being approved on another screen. Refresh to see the result.",
    wg_key_conflict:
      "This device's key is already linked to another device. Remove the existing one, then have this device generate a fresh code.",
    overlay_device_cap_reached:
      "You've reached the limit for linked remote devices. Remove one before linking another.",
    not_found:
      "This request is no longer in your queue. Refresh the list.",
  };

  if (err.code && KNOWN[err.code]) return KNOWN[err.code];

  // The 409 state guard: "cannot approve a {denied,expired,approving} enrollment".
  if (err.code && /^cannot approve a .+ enrollment$/.test(err.code)) {
    return "This request can no longer be approved. Refresh the list.";
  }

  // The 503 vouch-retry / not-yet-linked-to-fleet answers ship an honest,
  // customer-safe sentence in `error` — surface it as-is.
  if (err.status === 503) {
    return (
      err.message ||
      "The box is still connecting to its fleet directory. This device is back in your review queue — try approving again in a minute."
    );
  }

  return err.message || "Couldn't approve this device. Try again.";
}
