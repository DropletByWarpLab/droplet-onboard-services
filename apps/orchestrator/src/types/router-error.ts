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
  // WARP-1907 — the router-jack write's four typed refusals. Each is minted by
  // `setRouterPortEnabled` from the routing service's own body, NOT by
  // `routerErrorFromResponse`: that function classifies by status alone, and
  // three of these four statuses already mean something else there (502 is
  // reserved for a routing↔router credential rejection, 409 for
  // SCAN_UNSUPPORTED, and a bare 404/422 would land on UNKNOWN with the
  // server's sentence thrown away).
  | "PORT_WRITE_NOT_APPLIED"
  | "PORT_WRITE_REFUSED"
  | "PORT_NOT_FOUND"
  | "PORT_MAP_UNSUPPORTED"
  | "UNKNOWN";

/**
 * WARP-1907 — the guard a jack write tripped, carried on a `PORT_WRITE_REFUSED`
 * so the dashboard can escalate with the right title and the server's own
 * sentence.
 *
 * This exists for a race the cached read cannot cover: a jack published with
 * `disable_guard: null` that gains a cable between the poll and the click. The
 * server refuses it, and without this the dashboard has no escalation to offer
 * — the user sees a raw 409 and retrying fails until the next poll.
 */
export interface PortWriteGuardDetail {
  code: "WAN_PORT" | "MANAGEMENT_PORT";
  reason: string;
}

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly status?: number;
  /** Optional: which call failed, e.g. "Router summary". Carried through from routingFetch's `label`. */
  readonly label?: string;
  /**
   * WARP-1907 — structured payload a typed refusal needs the client to act on,
   * beyond the message. Only ever set by a factory below, so it is leak-free by
   * construction like `code`; the error handler surfaces it for trusted errors
   * on exactly the same terms.
   */
  readonly detail?: PortWriteGuardDetail;

  constructor(
    code: RouterErrorCode,
    message: string,
    options?: {
      status?: number;
      label?: string;
      cause?: unknown;
      detail?: PortWriteGuardDetail;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "RouterError";
    this.code = code;
    this.status = options?.status;
    this.label = options?.label;
    this.detail = options?.detail;
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

  /**
   * WARP-1907 — the routing service applied a jack write cleanly and uci still
   * reports the old value (routing `502 PORT_WRITE_NOT_APPLIED`).
   *
   * 🔴 This factory exists because `routerErrorFromResponse` maps EVERY 502 to
   * `AUTH`, on the documented WARP-1673 invariant that "nothing sits between
   * the orchestrator and routing to mint a 502". This write broke that
   * invariant. Rather than weaken a status-only rule that a real credential
   * rejection depends on, the port write reads its own body and mints this —
   * so the 502 never reaches that classifier. The invariant, and the test
   * pinning it, stand unchanged.
   *
   * 502 (kept): the failure is genuinely upstream of us and genuinely a server
   * fault. `message` is surfaced verbatim, so it must read as user-facing prose.
   */
  static portWriteNotApplied(
    message = "The router accepted the change but the port didn't move. Nothing was left half-applied — try again.",
    opts?: { label?: string; cause?: unknown },
  ): RouterError {
    return new RouterError("PORT_WRITE_NOT_APPLIED", message, { ...opts, status: 502 });
  }

  /**
   * WARP-1907 — the routing service refused a jack write because it would cut
   * the WAN or a live management jack, and the caller sent no `force`
   * (routing `409 WAN_PORT` / `MANAGEMENT_PORT`).
   *
   * `detail` carries the guard verbatim so the dashboard can raise its second,
   * destructive confirm from the server's own words. Reachable in normal use
   * despite the dashboard pre-checking `disable_guard` on the read: a jack that
   * was empty at poll time can gain a cable before the click.
   */
  static portWriteRefused(
    detail: PortWriteGuardDetail,
    opts?: { label?: string; cause?: unknown },
  ): RouterError {
    return new RouterError("PORT_WRITE_REFUSED", detail.reason, {
      ...opts,
      status: 409,
      detail,
    });
  }

  /**
   * WARP-1907 — the jack named is not on this router's port map (routing `404
   * PORT_NOT_FOUND`), or this shape publishes no port map at all (routing `422
   * PORT_MAP_UNSUPPORTED`).
   *
   * Both would otherwise land on `UNKNOWN` with the server's sentence replaced
   * by "Router port disable p9: 404 Not Found". The status is preserved and the
   * message is the routing service's, verbatim.
   */
  static portWriteRejected(
    code: "PORT_NOT_FOUND" | "PORT_MAP_UNSUPPORTED",
    message: string,
    opts?: { label?: string; cause?: unknown },
  ): RouterError {
    return new RouterError(code, message, {
      ...opts,
      status: code === "PORT_NOT_FOUND" ? 404 : 422,
    });
  }

  /** Shape sent over the wire to the dashboard. */
  toJSON(): {
    code: RouterErrorCode;
    message: string;
    status?: number;
    label?: string;
    detail?: PortWriteGuardDetail;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      label: this.label,
      detail: this.detail,
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
