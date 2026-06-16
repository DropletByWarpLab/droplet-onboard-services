import type { SystemHealthStatus } from "@/lib/api";

/**
 * Copy + status-dot token for each system-health status, plus an explicit
 * `unknown` fallback (WARP-576).
 *
 * `HEALTH_COPY` is declared as a total record over the known statuses *and*
 * a canonical `unknown` fallback, rather than letting an out-of-set status
 * resolve to `undefined`. The home page renders `systemHealth.status` straight
 * from the wire (`fetchSystemHealth`), so a backend that returns a status
 * outside the current union — a new severity tier, a typo, a degraded
 * gateway — must NOT white-screen the dashboard. Resolve every read through
 * `resolveHealthCopy(...)` so the lookup is total by construction.
 *
 * This mirrors the repo's "declare the canonical representation, never derive
 * from absence" standard (CLAUDE.md → "No guessing, ever").
 */
export interface HealthCopy {
  label: string;
  dot: string;
}

export const HEALTH_COPY: Record<SystemHealthStatus | "unknown", HealthCopy> = {
  ok: { label: "All systems operational", dot: "bg-system-green" },
  degraded: { label: "Degraded", dot: "bg-system-orange" },
  down: { label: "Needs attention", dot: "bg-system-red" },
  unknown: { label: "Status unavailable", dot: "bg-system-orange" },
};

/**
 * Total lookup: returns the copy for a known status, or the `unknown`
 * fallback for any other value (including malformed wire data). Never returns
 * `undefined`.
 */
export function resolveHealthCopy(status: string): HealthCopy {
  return (
    HEALTH_COPY[status as SystemHealthStatus] ?? HEALTH_COPY.unknown
  );
}
