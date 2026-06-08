/**
 * Frontend feature flags.
 *
 * These gate UI surfaces whose backing endpoint / data structure does NOT
 * exist yet. The rule (per repo policy): never ship stubbed/hardcoded data
 * dressed up as real. A surface with no backend is hidden by default and only
 * shown when its flag is explicitly enabled — useful for design preview / dev.
 *
 * Each flag below has a tracked feature request in `docs/feature-requests.md`
 * describing the endpoint + data structure that would make it real. When that
 * backend lands, wire the widget to the real hook and delete the flag.
 *
 * Flags are read from `NEXT_PUBLIC_FEATURE_*` build-time env (Next inlines
 * them). Unset → false (hidden). Set to "1" or "true" → shown.
 */

function on(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export const FEATURES = {
  /** Home "Tasks" widget — needs a per-user to-do store (FR-001). */
  homeTasks: on(process.env.NEXT_PUBLIC_FEATURE_HOME_TASKS),
  /** Home "Activity" timeline — needs an aggregated activity feed (FR-002). */
  homeActivity: on(process.env.NEXT_PUBLIC_FEATURE_HOME_ACTIVITY),
  /** Home "Smart home" scenes — needs Matter scene CRUD + recall (FR-003). */
  homeScenes: on(process.env.NEXT_PUBLIC_FEATURE_HOME_SCENES),
  /** Home "Tools" automations — needs a scheduled-automation store (FR-004). */
  homeAutomations: on(process.env.NEXT_PUBLIC_FEATURE_HOME_AUTOMATIONS),
} as const;

export type FeatureFlag = keyof typeof FEATURES;
