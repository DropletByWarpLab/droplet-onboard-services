"use client";

import useSWR from "swr";
import { authFetch, useAuth } from "../auth";

/**
 * WARP-1397 — the sidebar's module gate. Returns a predicate that answers
 * whether a user-facing module is EFFECTIVE (available && enabled) on this
 * Droplet, so a nav entry for a switched-off feature is removed rather than
 * leading to a dead, module-gated 404 (the confusing state Stefan hit after
 * the Features panel shipped).
 *
 * Fail-OPEN, deliberately (matches useAppCapabilities): until the probe
 * resolves — and on ANY error, including a 404 from an older orchestrator that
 * predates GET /api/modules — every module reads as effective, so a network
 * blip or version skew can never make a shipping surface vanish. A nav item is
 * hidden ONLY when we positively know its module is off. Core modules (chat)
 * are always effective; an id the registry doesn't know reads as effective too
 * (never hide a nav entry we can't classify).
 *
 * Self-contained (no dependency on the Features-panel api helpers) but shares
 * the `/api/modules` SWR key with them, so a Features toggle is reflected in
 * the nav on the next focus / navigation revalidation, or the poll interval at
 * worst — never a reload. (The Features panel does not mutate this key today; a
 * `mutate('/api/modules')` there would make the nav update immediate.)
 *
 * WARP-1528: the same endpoint now also carries `effectiveForUser` (workspace ∩
 * the caller's role grants, ADR-032 §3). When present it supersedes the
 * workspace flags here, so every consumer — all three nav surfaces and the
 * route guard — narrows per person off ONE fetch. The fail-open posture is
 * unchanged and deliberate: this hook is a convenience layer, and
 * `requireFeatureAccess` on the orchestrator is the actual boundary.
 */

const MODULES_KEY = "/api/modules";

interface ModuleState {
  id: string;
  effective: boolean;
}
interface EffectiveFeature {
  moduleId: string;
  level: "view" | "act" | "manage";
}
interface ModulesView {
  modules: ModuleState[];
  /**
   * WARP-1528 / ADR-032 §3(a) — the PER-USER view: workspace-effective ∩ this
   * person's §9 feature grants, resolved server-side. Absent when the
   * orchestrator predates T4 or couldn't resolve the caller (it omits rather
   * than sends an empty set), in which case the workspace view stands.
   */
  effectiveForUser?: EffectiveFeature[];
}

async function fetchModules(): Promise<ModulesView> {
  const res = await authFetch(MODULES_KEY);
  if (!res.ok) throw new Error(`Failed to fetch modules: ${res.status}`);
  return res.json();
}

/**
 * The fail-open decision, extracted pure for testing:
 *  - probe not resolved (`data` undefined) → shown (never hide on a blip)
 *  - the server sent a PER-USER set → membership in that set is the answer
 *    (it already contains the workspace intersection — ADR-032 §3 — so
 *    re-checking `effective` on top would be redundant and could only
 *    disagree with the server, which is the authority)
 *  - otherwise: module known → its `effective` flag
 *  - module unknown to the registry → shown (never hide what we can't classify)
 *
 * An EMPTY `effectiveForUser` is treated as unresolved, not as "nothing" — a
 * malformed/partial payload must not blank the whole nav.
 *
 * WARP-1528 (QA): the reason a genuinely empty set is impossible is that the
 * always-on floor is EXEMPT FROM THE WORKSPACE INTERSECTION in the resolver
 * (effective-access.service.ts) — not merely that "chat is always on". The
 * distinction is load-bearing: `chat` is a core module but its registry
 * availability is `isSet(AI_GATEWAY_URL)`, so on a gateway-less box it does
 * drop out of the workspace-effective set, and before that exemption a
 * role-holder with no surviving grants resolved to `[]`. The server also now
 * omits the field rather than sending `[]`, so this guard is defence in depth
 * on both counts.
 */
export function isModuleEffective(
  data: ModulesView | undefined,
  moduleId: string,
): boolean {
  if (!data) return true;
  const perUser = data.effectiveForUser;
  if (perUser && perUser.length > 0) {
    return perUser.some((f) => f.moduleId === moduleId);
  }
  const m = data.modules.find((x) => x.id === moduleId);
  return m ? m.effective : true;
}

const MODULES_SWR_OPTIONS = {
  // Module state changes only when the owner reconfigures the box. The
  // Features toggle revalidates this key explicitly for the instant update;
  // revalidateOnFocus + a modest poll are the standalone safety net so the
  // nav can't lag long without that mutate.
  refreshInterval: 120_000,
  revalidateOnFocus: true,
  shouldRetryOnError: false,
} as const;

export function useModuleGate(): (moduleId: string) => boolean {
  const { data } = useSWR<ModulesView>(MODULES_KEY, fetchModules, MODULES_SWR_OPTIONS);

  return (moduleId: string): boolean => isModuleEffective(data, moduleId);
}

/** The caller's §9 level on one module, or `none` when they hold none of it. */
export type ModuleLevel = "none" | "view" | "act" | "manage";

/**
 * WARP-2977 P2b — WHICH level the caller holds, for hiding act/manage
 * controls. Extracted pure for testing.
 *
 * Fail-CLOSED for actions, the opposite posture to `isModuleEffective`, and
 * deliberately so: a nav entry hidden by mistake is an annoyance, but a
 * control rendered to someone the server will refuse turns every click into
 * a `requireFeatureAccess` denial — an auth/warn ActivityRow that the
 * Security threat mirror then shows as a threat. So:
 *  - probe not resolved, or it failed (`data` undefined) → `view`;
 *  - the server sent a (non-empty) PER-USER set → that entry's level, or
 *    `none` when the module is absent from it;
 *  - no per-user set (the caller has no local row, or the server's resolver
 *    failed — it omits the field) → `manage` for an owner (the §3 bypass),
 *    `view` for everyone else.
 * An EMPTY `effectiveForUser` is treated as absent, as `isModuleEffective`
 * does. Never infer manage from `isAdminRole`: admins can be narrowed.
 */
export function moduleLevelFor(
  data: ModulesView | undefined,
  moduleId: string,
  role: string | undefined,
): ModuleLevel {
  if (!data) return "view";
  const perUser = data.effectiveForUser;
  if (perUser && perUser.length > 0) {
    return perUser.find((f) => f.moduleId === moduleId)?.level ?? "none";
  }
  return role === "owner" ? "manage" : "view";
}

/**
 * The caller's level on `moduleId`, off the same `/api/modules` fetch (and
 * SWR key) as the nav gate. `requireFeatureAccess` on the orchestrator is
 * still the boundary; this only decides which controls to render.
 */
export function useModuleLevel(moduleId: string): ModuleLevel {
  const { user } = useAuth();
  const { data } = useSWR<ModulesView>(MODULES_KEY, fetchModules, MODULES_SWR_OPTIONS);
  return moduleLevelFor(data, moduleId, user?.role);
}

/** True when `level` is at least `min` — `levelAtLeast(level, "act")` to show an act control. */
export function levelAtLeast(level: ModuleLevel, min: Exclude<ModuleLevel, "none">): boolean {
  const rank: Record<ModuleLevel, number> = { none: 0, view: 1, act: 2, manage: 3 };
  return rank[level] >= rank[min];
}

export const MODULE_GATE_KEY = MODULES_KEY;
