/**
 * WARP-1259 (T7) — centralized department transaction helpers.
 *
 * `bumpAclVersion` was inlined in `routes/departments.ts` by T6 (WARP-1258)
 * with a comment reserving this module for T7 to centralize it. Every
 * membership/state mutation across departments.ts and
 * department-membership.service.ts must bump `Department.aclVersion`
 * **inside the same `$transaction`** as the mutation itself (brief §3.2 —
 * search-cache keys embed `max(aclVersion)`; a mutation that lands without
 * bumping the version is invisible to cache invalidation, not just slow to
 * invalidate).
 */
import type { PrismaClient } from "@prisma/client";

/** The subset of the Prisma tx client this helper needs — matches the
 * interactive-transaction callback type Prisma infers for `$transaction`. */
type TxClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Bump `Department.aclVersion` by 1, in place, within an active `tx`.
 * Call this from inside every `prisma.$transaction(async (tx) => { ... })`
 * block that creates/updates/removes a Department or DepartmentMembership
 * row. Never call outside a transaction — the whole point is atomicity
 * with the mutation it accompanies.
 */
export async function bumpAclVersion(
  tx: TxClient,
  departmentId: string,
): Promise<void> {
  await tx.department.update({
    where: { id: departmentId },
    data: { aclVersion: { increment: 1 } },
  });
}
