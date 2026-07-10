/**
 * ErpError — structured error for the ERP-integration orchestrator layer
 * (WARP-1137, EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF §13, §14).
 *
 * Mirrors `router-error.ts`: a typed `code` enum, an optional HTTP `status`,
 * a `toJSON()` for wire serialization, and static factories. The route layer
 * catches `err instanceof ErpError` and renders `code` so the dashboard can
 * branch (e.g. render a "connect Eaglesoft" empty state on `ERP_NOT_CONNECTED`
 * vs a hard error banner on `ERROR`).
 *
 * DB-INDEPENDENT SLICE: the connector's live SQL Anywhere calls are stubbed and
 * throw `ConnectorBlockedError`. The service layer catches that and surfaces an
 * HONEST `ERP_NOT_CONNECTED` — never a fake success (WARP-1137 scope boundary).
 */

export type ErpErrorCode =
  | "ERP_NOT_CONNECTED" // the connector could not reach Eaglesoft (stubbed → blocked)
  | "NOT_CONFIGURED" // no IntegrationConnection row exists for the provider
  | "WRITE_NOT_ENABLED" // per-practice write opt-in is off (invariant 1)
  | "WRITE_NOT_CONFIRMED" // apply attempted before a human confirmed the request
  | "INVALID_STATE" // write-request lifecycle transition is not permitted
  | "NOT_FOUND" // the referenced write request / connection does not exist
  | "FORBIDDEN" // RBAC / PHI minimum-necessary denial (invariant 11, §14)
  | "VALIDATION" // malformed request body / params
  | "ERROR"; // unrecoverable connector / orchestrator failure

/**
 * Structured ERP error. Extends `Error` so existing `throw` / `catch` sites
 * keep working; downstream code branches on `err instanceof ErpError` +
 * `err.code`. `status` lets the global error handler pick the right HTTP code.
 */
export class ErpError extends Error {
  readonly code: ErpErrorCode;
  readonly status: number;

  constructor(
    code: ErpErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ErpError";
    this.code = code;
    this.status = options?.status ?? ErpError.defaultStatusFor(code);
  }

  private static defaultStatusFor(code: ErpErrorCode): number {
    switch (code) {
      case "VALIDATION":
        return 400;
      case "FORBIDDEN":
        return 403;
      case "NOT_FOUND":
        return 404;
      case "NOT_CONFIGURED":
      case "WRITE_NOT_ENABLED":
      case "WRITE_NOT_CONFIRMED":
      case "INVALID_STATE":
        return 409;
      case "ERP_NOT_CONNECTED":
        // The Eaglesoft dependency is unavailable (stubbed / not connected),
        // not an orchestrator bug — 503, same posture as RouterError.unreachable.
        return 503;
      case "ERROR":
      default:
        return 500;
    }
  }

  /** Wire shape rendered by the route layer. Never carries a secret / PHI. */
  toJSON(): { error: string; code: ErpErrorCode } {
    return { error: this.message, code: this.code };
  }

  static notConnected(message = "ERP is not connected"): ErpError {
    return new ErpError("ERP_NOT_CONNECTED", message);
  }
  static notConfigured(provider: string): ErpError {
    return new ErpError(
      "NOT_CONFIGURED",
      `no integration configured for provider "${provider}"`,
    );
  }
  static writeNotEnabled(): ErpError {
    return new ErpError(
      "WRITE_NOT_ENABLED",
      "writes are disabled for this integration (per-practice opt-in required)",
    );
  }
  static writeNotConfirmed(): ErpError {
    return new ErpError(
      "WRITE_NOT_CONFIRMED",
      "a write request must be confirmed by a human before it can be applied",
    );
  }
  static invalidState(from: string, action: string): ErpError {
    return new ErpError(
      "INVALID_STATE",
      `cannot ${action} a request in state "${from}"`,
    );
  }
  static notFound(what: string): ErpError {
    return new ErpError("NOT_FOUND", `${what} not found`);
  }
  static forbidden(message = "forbidden: PHI access not permitted for this role"): ErpError {
    return new ErpError("FORBIDDEN", message);
  }
  static validation(message: string): ErpError {
    return new ErpError("VALIDATION", message);
  }
  static internal(message: string, cause?: unknown): ErpError {
    return new ErpError("ERROR", message, { cause });
  }
}
