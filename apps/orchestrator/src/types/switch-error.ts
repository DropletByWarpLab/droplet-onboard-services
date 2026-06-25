/**
 * SwitchAuthError — distinct typed error for the switch-service auth seam
 * (PR #709 review, DECISION 1 / DECISION 3).
 *
 * The switch service runs network_mode: host and FAILS CLOSED when its
 * SERVICE_SECRET is unset (or the orchestrator presents a wrong/missing bearer):
 * it returns HTTP 403 on every non-/health route. A genuinely-absent switch, by
 * contrast, raises HTTP 503 on the hardware reads — which the §7 aggregation
 * deliberately swallows to its calm "no managed switch" empty state.
 *
 * Without a distinct error type a 403 auth-config failure would be swallowed by
 * the aggregation's `safe()` wrapper exactly like a 503, so a misconfigured
 * deploy would render as "no switch present" — indistinguishable from real
 * absent hardware. This error lets the aggregation tell the two apart and thread
 * an `auth_not_configured` flag through to the dashboard so a banner can say
 * "Switch auth not configured" instead of the empty state.
 *
 * Extends Error so existing throw/catch sites keep working; callers branch on
 * `err instanceof SwitchAuthError`.
 */
export class SwitchAuthError extends Error {
  readonly code = "SWITCH_AUTH" as const;
  readonly status: number;
  /** Which call failed, e.g. "Switch ports". */
  readonly label?: string;

  constructor(message: string, options?: { status?: number; label?: string }) {
    super(message);
    this.name = "SwitchAuthError";
    this.status = options?.status ?? 403;
    this.label = options?.label;
  }

  /** Shape sent over the wire (mirrors RouterError.toJSON()). */
  toJSON(): { code: "SWITCH_AUTH"; message: string; status: number; label?: string } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      label: this.label,
    };
  }
}
