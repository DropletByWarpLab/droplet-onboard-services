/**
 * WARP-1531 / ADR-032 (RBAC v2 T7) — effective usage resolution.
 *
 * The §3 usage line of the resolver:
 *
 *   usage = UserUsagePolicy(userId) ?? AccessRole defaults ?? box default
 *
 * resolved FIELD-BY-FIELD: a person row with only storage set still
 * inherits its role's upload cap. A null field means "unset — fall
 * through", never "explicit zero". Every resolved field carries an
 * explicit `source` (person | role | default) so callers never have to
 * guess provenance from a null (CLAUDE.md no-guessing rule) and the
 * admin roster can render it honestly.
 *
 * Box defaults are the CALLER's business, so a fully-defaulted field is
 * `{ value: null, source: "default" }`:
 *   - storageQuotaBytes → no orchestrator-managed quota (Nextcloud keeps
 *     whatever it has — today's no-policy-row behavior);
 *   - maxUploadSizeMb   → config.MAX_UPLOAD_SIZE_MB (files.ts multer path);
 *   - llmDailyMessageCap→ uncapped (D-7: enforcement stays deferred —
 *     resolved + exposed here, deliberately NOT wired into llm.ts).
 *
 * Zero-AccessRole-rows invariant (production today — nothing creates
 * role rows until T3): `User.accessRoleId` null resolves person ?? box
 * default, byte-identical to pre-WARP-1531 behavior on every wired path.
 *
 * The T3 `effective-access.service.ts` resolver consumes this module for
 * its `usage` line; keep it dependency-free (no NC client, no activity)
 * so it stays a pure read.
 */
import type { PrismaClient } from "@prisma/client";

export type EffectiveUsageSource = "person" | "role" | "default";

export interface EffectiveUsageField<T> {
  /** Resolved value; `null` ⇔ `source === "default"` (caller applies its box default). */
  value: T | null;
  source: EffectiveUsageSource;
}

export interface EffectiveUsagePolicy {
  storageQuotaBytes: EffectiveUsageField<bigint>;
  maxUploadSizeMb: EffectiveUsageField<number>;
  llmDailyMessageCap: EffectiveUsageField<number>;
}

/**
 * The three usage-default fields shared (same names, same types) by
 * `UserUsagePolicy` (person row) and `AccessRole` (role defaults).
 * Partial so callers may pass narrower Prisma selects.
 */
export interface UsageDefaultFields {
  storageQuotaBytes?: bigint | null;
  maxUploadSizeMb?: number | null;
  llmDailyMessageCap?: number | null;
}

function pickField<T>(
  personValue: T | null | undefined,
  roleValue: T | null | undefined,
): EffectiveUsageField<T> {
  if (personValue != null) return { value: personValue, source: "person" };
  if (roleValue != null) return { value: roleValue, source: "role" };
  return { value: null, source: "default" };
}

/**
 * Pure per-field resolution. `person` is the user's `UserUsagePolicy` row
 * (or null when none), `role` their `AccessRole` (or null when
 * `accessRoleId` is null — today's world). A missing row and a row of
 * all-null fields resolve identically.
 */
export function resolveEffectiveUsage(
  person: UsageDefaultFields | null | undefined,
  role: UsageDefaultFields | null | undefined,
): EffectiveUsagePolicy {
  return {
    storageQuotaBytes: pickField(person?.storageQuotaBytes, role?.storageQuotaBytes),
    maxUploadSizeMb: pickField(person?.maxUploadSizeMb, role?.maxUploadSizeMb),
    llmDailyMessageCap: pickField(person?.llmDailyMessageCap, role?.llmDailyMessageCap),
  };
}

/**
 * Fetch-and-resolve for callers that only hold a userId (files.ts upload
 * path). Two indexed point reads; the person read deliberately stays on
 * the `userUsagePolicy` delegate (the seam the WARP-1271 upload-cap
 * regression tests pin) rather than a nested user select. A missing user
 * row (deleted mid-request) degrades to all box defaults — resolution
 * never throws; enforcement callers fall back to their config ceiling.
 */
export async function getEffectiveUsage(
  prisma: PrismaClient,
  userId: string,
): Promise<EffectiveUsagePolicy> {
  const [person, user] = await Promise.all([
    prisma.userUsagePolicy.findUnique({
      where: { userId },
      select: {
        storageQuotaBytes: true,
        maxUploadSizeMb: true,
        llmDailyMessageCap: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        accessRole: {
          select: {
            storageQuotaBytes: true,
            maxUploadSizeMb: true,
            llmDailyMessageCap: true,
          },
        },
      },
    }),
  ]);
  return resolveEffectiveUsage(person, user?.accessRole ?? null);
}
