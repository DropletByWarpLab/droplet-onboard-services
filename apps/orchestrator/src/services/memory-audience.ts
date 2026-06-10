/**
 * WARP-845 — role-audience ladder for memory facts.
 *
 * Visibility rule: a caller sees a fact when their role rank is AT OR
 * ABOVE the fact's audience rank (owner > admin > family > guest).
 * `service` (voice-io) acts for household members near the device and
 * gets the family view; unknown/absent roles get the guest view (most
 * restrictive) so a misconfigured caller can never over-read.
 */
export type MemoryAudience = "owner" | "admin" | "family" | "guest";

const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1, // household-proximate principal — family-level reach
  guest: 0,
};

const AUDIENCE_RANK: Record<MemoryAudience, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  guest: 0,
};

export function roleRank(role: string | undefined): number {
  return ROLE_RANK[role ?? ""] ?? 0;
}

/** Audiences whose facts the given role may read. */
export function visibleAudiences(role: string | undefined): MemoryAudience[] {
  const rank = roleRank(role);
  return (Object.keys(AUDIENCE_RANK) as MemoryAudience[]).filter(
    (a) => AUDIENCE_RANK[a] <= rank,
  );
}

/** May this role create/retarget a fact at the given audience?
 *  You can't mint facts more privileged than yourself. */
export function canTargetAudience(
  role: string | undefined,
  audience: MemoryAudience,
): boolean {
  return AUDIENCE_RANK[audience] <= roleRank(role);
}
