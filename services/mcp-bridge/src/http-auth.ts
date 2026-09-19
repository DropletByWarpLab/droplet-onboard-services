/**
 * WARP-2627 — the bearer between the orchestrator and this component.
 *
 * The shape is `services/web-fetch/main.py`'s `require_bearer`, transcribed
 * rather than reinvented, including the property that matters most:
 *
 *   > Fails CLOSED when no token is configured: an unset token (e.g. a failed
 *   > secret injection at deploy) yields 503 on every non-/health route rather
 *   > than silently opening the one component with outbound HTTP.
 *
 * That is the same sentence for this service, with one word changed. web-fetch
 * reaches two keyless public providers; this component reaches a customer's own
 * Atlassian tenant with a credential the customer minted. An unauthenticated
 * `POST /sessions/atlassian/call` would let anything that can reach the compose
 * network drive that credential.
 *
 * DELIBERATELY NO `*_ALLOW_NO_AUTH` dev escape, for the same reason web-fetch
 * has none: this service must never run open, and a knob that lets it is a knob
 * somebody sets on a box.
 *
 * `/health` is exempt so the compose healthcheck works without a secret. It
 * returns the constant `{status:"ok"}` and reads nothing — and that claim is
 * now enforced by `http-api.test.ts`, because it was FALSE from #1964 until
 * WARP-2300 review: the handler also returned `knownServerIds()` and
 * `store.healthAll()`, so any container on the compose bridge network could
 * read which vendors the box knows plus every session's `state`, `toolCount`,
 * `consecutiveFailures`, `lastReadyAt` and `reason` — i.e. whether the customer
 * has connected Atlassian and whether their credential is being rejected — with
 * no credential at all. That is WARP-2111's shape one layer down.
 *
 * ANY new exempt path inherits that constraint: an exemption is a decision to
 * publish the body to every container on the bridge network, so the route must
 * answer something that is true of the process and says nothing about the
 * customer, their vendors or their credentials. The inventory lives at
 * `GET /sessions`, behind the bearer.
 */
import { timingSafeEqual } from "node:crypto";

/** Paths served without a bearer. One entry, and it answers `{status:"ok"}`
 *  and nothing else — see the note above before adding a second. */
export const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(["/health"]);

export type BridgeAuthVerdict =
  | { ok: true }
  /** No token is configured on this container — 503, not 401: the operator's
   *  remedy is to provision the secret, not to present a different one. */
  | { ok: false; status: 503; code: "AUTH_NOT_CONFIGURED" }
  | { ok: false; status: 401; code: "UNAUTHORIZED" };

/**
 * Check one request's `Authorization` header against the configured token.
 *
 * Compared with {@link timingSafeEqual} over equal-length buffers (a length
 * mismatch short-circuits to a refusal, which leaks only the length — the same
 * trade `authMiddleware`'s service-token path makes).
 */
export function checkBridgeBearer(
  path: string,
  authorization: string | null | undefined,
  configuredToken: string,
): BridgeAuthVerdict {
  if (AUTH_EXEMPT_PATHS.has(path)) return { ok: true };
  if (configuredToken.length === 0) {
    return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED" };
  }
  const header = authorization ?? "";
  const at = header.indexOf(" ");
  const scheme = at === -1 ? header : header.slice(0, at);
  const presented = at === -1 ? "" : header.slice(at + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || presented.length === 0) {
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  }
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configuredToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  }
  return { ok: true };
}
