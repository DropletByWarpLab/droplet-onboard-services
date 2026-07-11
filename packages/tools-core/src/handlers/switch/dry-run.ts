/**
 * WARP-1176 (PYNET-001) — plan-only (dry-run) switch writes must never read
 * as applied changes to the model.
 *
 * The switch driver runs plan-only by default (SWITCH_LIVE_WRITES=0): every
 * write is computed but never hits hardware, and the switch service reports
 * that as `status: "planned"` + `dry_run: true`. The raw fields are easy for
 * the model to skim past inside an `ok: true` tool result, so annotate the
 * payload with an explicit, unmissable warning. The agent must relay the
 * change as planned-but-not-applied — telling the operator "the camera VLAN
 * is configured" when nothing touched hardware is exactly the audit finding
 * this guards against.
 */

export const DRY_RUN_WARNING =
  "planned (dry-run) — NOT applied to hardware. The switch driver is in " +
  "plan-only mode (SWITCH_LIVE_WRITES=0): the change was computed and " +
  "validated but no configuration was written to the switch. Report this " +
  "to the user as a plan, not as a completed change.";

/**
 * If a switch write response signals plan-only (`dry_run: true` or
 * `status: "planned"`), stamp `applied: false` and the explicit warning onto
 * the payload. Applied (live-write) responses pass through untouched.
 */
export function annotateDryRun(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const d = data as Record<string, unknown>;
  if (d.dry_run === true || d.status === "planned") {
    return { ...d, dry_run: true, applied: false, warning: DRY_RUN_WARNING };
  }
  return data;
}
