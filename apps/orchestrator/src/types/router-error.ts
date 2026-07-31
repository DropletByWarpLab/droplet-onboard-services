/**
 * RouterError — structured error for the routing-service surface (WARP-39).
 *
 * Previously the network service caught every failure and returned an empty
 * `NetworkOverview` with `routerConnected: false`. The dashboard then rendered
 * "Router Not Connected" without knowing *why* — timeout, bad credentials,
 * routing container down, or a safe-apply rollback all looked identical.
 *
 * Every error now carries a `code`:
 *   - UNREACHABLE  — network error, connection refused, DNS failure, retries exhausted
 *   - TIMEOUT      — AbortController fired (deliberate timeout or user cancel)
 *   - AUTH         — routing service returned 401 or 403
 *   - ROLLED_BACK  — safe-apply rolled the change back (WARP-40 surfaces this separately;
 *                    included here so callers of write endpoints can handle it uniformly)
 *   - UNKNOWN      — anything else (5xx that isn't a rollback, unexpected response shape)
 *
 * The class extends Error so existing `throw` / `catch` call sites keep working;
 * downstream code branches on `err instanceof RouterError` + `err.code`.
 */

export type RouterErrorCode =
  | "UNREACHABLE"
  | "TIMEOUT"
  | "AUTH"
  | "ROLLED_BACK"
  | "DISABLED"
  | "SCAN_UNSUPPORTED"
  | "UNKNOWN";

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly status?: number;
  /** Optional: which call failed, e.g. "Router summary". Carried through from routingFetch's `label`. */
  readonly label?: string;

  constructor(
    code: RouterErrorCode,
    message: string,
    options?: { status?: number; label?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "RouterError";
    this.code = code;
    this.status = options?.status;
    this.label = options?.label;
  }

  static unreachable(message: string, opts?: { label?: string; cause?: unknown }): RouterError {
    // WARP-807: the routing service / OpenWrt is an upstream dependency. When it
    // can't be reached the correct HTTP status is 503 Service Unavailable, not a
    // bare 500. Carrying it here lets the global error handler's `resolveStatus`
    // return 503 (instead of null → 500) and surface the actionable message.
    return new RouterError("UNREACHABLE", message, { ...opts, status: 503 });
  }
  static timeout(message: string, opts?: { label?: string; cause?: unknown }): RouterError {
    // WARP-807: a timeout talking to the upstream router is also a 503 — the
    // dependency is unavailable (slow / not responding), not an orchestrator bug.
    return new RouterError("TIMEOUT", message, { ...opts, status: 503 });
  }
  static auth(message: string, opts?: { label?: string; status?: number }): RouterError {
    return new RouterError("AUTH", message, opts);
  }
  static rolledBack(message: string, opts?: { label?: string; status?: number }): RouterError {
    return new RouterError("ROLLED_BACK", message, opts);
  }
  static unknown(message: string, opts?: { label?: string; status?: number; cause?: unknown }): RouterError {
    return new RouterError("UNKNOWN", message, opts);
  }
  /**
   * WARP-44: produced when `ROUTING_MODE=disabled`. The orchestrator
   * short-circuits every routing call without hitting the network — the
   * dashboard renders a "Router supervision disabled" banner.
   */
  static disabled(label = "router"): RouterError {
    // WARP-807: `ROUTING_MODE=disabled` means the router-supervision dependency
    // is intentionally unavailable. A WRITE that needs it gets 503 (the wizard
    // surfaces "finish this from Settings later" + keeps Skip), not a 500.
    return new RouterError("DISABLED", "Router supervision is disabled", { label, status: 503 });
  }
  /**
   * WARP-816: a Wi-Fi scan can't run because the radio is in an AP/Master role
   * (the single-box broadcasts its own network on its only radio, so it can't
   * station-scan). Distinct from a successful scan that finds zero networks —
   * the routing service signals this with HTTP 409 + code `SCAN_UNSUPPORTED`.
   *
   * 409 (not 503): the dependency is reachable and working — this is a stable,
   * terminal capability fact about the hardware shape, not a reachability
   * outage. The dashboard branches on the code to render calm "scanning
   * unavailable while broadcasting" copy + disable the Scan control, never the
   * raw code. The `message` is surfaced verbatim, so it must read as
   * user-facing prose.
   */
  static scanUnsupported(
    message = "Your Droplet can't scan for other Wi-Fi networks while it's broadcasting its own. That's expected on this setup — nothing's wrong.",
    opts?: { label?: string; cause?: unknown },
  ): RouterError {
    return new RouterError("SCAN_UNSUPPORTED", message, { ...opts, status: 409 });
  }

  /** Shape sent over the wire to the dashboard. */
  toJSON(): { code: RouterErrorCode; message: string; status?: number; label?: string } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      label: this.label,
    };
  }
}

/**
 * Map a fetch Response (4xx/5xx) to a RouterError. Centralized so every
 * caller in the network surface produces the same classification.
 */
export function routerErrorFromResponse(res: Response, label: string): RouterError {
  const base = `${label}: ${res.status} ${res.statusText || ""}`.trim();
  if (res.status === 401 || res.status === 403) {
    return RouterError.auth(base, { label, status: res.status });
  }
  // WARP-1673: the routing service reserves 502 for "the ROUTER rejected the
  // routing service's own rpcd credentials" (e.g. an edge-router reflash
  // rotated droplet-ai-password; body carries code ROUTER_AUTH). Nothing sits
  // between the orchestrator and routing to mint a 502, so the status alone is
  // unambiguous — same status-only classification discipline as the 409
  // SCAN_UNSUPPORTED contract. Checked before the X-Operation-Id rollback
  // branch: an auth-refused write never changed anything, so AUTH is the
  // truthful classification even on a write path.
  if (res.status === 502) {
    return RouterError.auth(base, { label, status: res.status });
  }
  // WARP-40 introduced X-Operation-Id on every write; if a 5xx carries one we
  // assume it's a safe-apply rollback. Not all 5xx are rollbacks, but this
  // classification is only used on write paths.
  if (res.status >= 500 && res.headers.get("X-Operation-Id")) {
    return RouterError.rolledBack(base, { label, status: res.status });
  }
  if (res.status >= 500) {
    return RouterError.unreachable(base, { label });
  }
  return RouterError.unknown(base, { label, status: res.status });
}

/**
 * Map a thrown fetch-layer error (network failure, abort, etc.) to a RouterError.
 */
export function routerErrorFromThrown(err: unknown, label: string): RouterError {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return RouterError.timeout(`${label}: timed out`, { label, cause: error });
  }
  // Node's undici tags TypeError for network failures (fetch failed / ECONNREFUSED).
  return RouterError.unreachable(`${label}: ${error.message}`, { label, cause: error });
}
