/**
 * WARP-2977 P2b-2 (DS-019) — THE door-lock rule: may a person with this
 * resolved §9 catalog see door locks on the Security surfaces? Devices
 * (smart_home) at view or above; the owner's catalog always holds it (the
 * resolver's §3 bypass).
 *
 *   · resolved → exactly that entry. An admin narrowed off Devices is out.
 *   · unresolved (null: no local User row, a service principal, no
 *     principal) → owner/admin only. Fail closed.
 *
 * A LEAF (WARP-2979 P4 PR-4): security-access's scope and the alert
 * notifier's per-recipient check (a reason that names a lock) both read it,
 * and the notifier must not import security-access — that edge closes an
 * import ring through the lock adapter (import-cycles.test.ts, WARP-3193
 * ARCH-1). So the rule lives here, with nothing but the catalog's ranks.
 */
import type { EffectiveAccessResult } from "./effective-access.service.js";
import { FEATURE_LEVEL_RANK } from "./access-catalog.js";

export function locksReadableWith(access: Pick<EffectiveAccessResult, "features"> | null, role: string | undefined): boolean {
  if (!access) return role === "owner" || role === "admin";
  const level = access.features.find((f) => f.moduleId === "smart_home")?.level;
  return level !== undefined && FEATURE_LEVEL_RANK[level] >= FEATURE_LEVEL_RANK.view;
}
