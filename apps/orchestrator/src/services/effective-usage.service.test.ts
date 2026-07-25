/**
 * WARP-1531 / ADR-032 (RBAC v2 T7) — effective usage resolution tests.
 *
 * Locks the §3 usage line of the resolver:
 *
 *   usage = UserUsagePolicy(userId) ?? AccessRole defaults ?? box default
 *
 * resolved FIELD-BY-FIELD (a person row with only storage set still
 * inherits the role's upload cap), each field carrying an explicit
 * `source: "person" | "role" | "default"` — never inferred by the caller
 * from a null (CLAUDE.md no-guessing rule).
 *
 * The zero-AccessRole-rows invariant (production today — nothing creates
 * role rows until T3 ships) is pinned here at the resolver level: with no
 * role, every field resolves exactly as current main does (person value
 * or box default; source never "role").
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  resolveEffectiveUsage,
  getEffectiveUsage,
  type UsageDefaultFields,
} from "./effective-usage.service.js";

const GIB = 1024n * 1024n * 1024n;

const EMPTY: UsageDefaultFields = {
  storageQuotaBytes: null,
  maxUploadSizeMb: null,
  llmDailyMessageCap: null,
};

describe("resolveEffectiveUsage — per-field precedence matrix", () => {
  // Every (person-set × role-set) combination, per field. Values are chosen
  // distinct so a wrong-source pick can never accidentally equal the right
  // value.
  const CASES = [
    // field, person field value, role field value, expected value, expected source
    ["storageQuotaBytes", 5n * GIB, 10n * GIB, 5n * GIB, "person"],
    ["storageQuotaBytes", 5n * GIB, null, 5n * GIB, "person"],
    ["storageQuotaBytes", null, 10n * GIB, 10n * GIB, "role"],
    ["storageQuotaBytes", null, null, null, "default"],
    ["maxUploadSizeMb", 25, 100, 25, "person"],
    ["maxUploadSizeMb", 25, null, 25, "person"],
    ["maxUploadSizeMb", null, 100, 100, "role"],
    ["maxUploadSizeMb", null, null, null, "default"],
    ["llmDailyMessageCap", 40, 200, 40, "person"],
    ["llmDailyMessageCap", 40, null, 40, "person"],
    ["llmDailyMessageCap", null, 200, 200, "role"],
    ["llmDailyMessageCap", null, null, null, "default"],
  ] as const;

  for (const [field, personVal, roleVal, expectedVal, expectedSource] of CASES) {
    it(`${field}: person=${personVal ?? "unset"} role=${roleVal ?? "unset"} → ${String(
      expectedVal ?? "box default",
    )} (${expectedSource})`, () => {
      const person = { ...EMPTY, [field]: personVal };
      const role = { ...EMPTY, [field]: roleVal };
      const effective = resolveEffectiveUsage(person, role);
      expect(effective[field].value).toStrictEqual(expectedVal);
      expect(effective[field].source).toBe(expectedSource);
    });
  }

  it("a missing person ROW behaves exactly like a row with every field null", () => {
    const role = { ...EMPTY, maxUploadSizeMb: 50 };
    expect(resolveEffectiveUsage(null, role)).toEqual(
      resolveEffectiveUsage(EMPTY, role),
    );
  });

  it("a missing ROLE behaves exactly like a role with every field null", () => {
    const person = { ...EMPTY, llmDailyMessageCap: 12 };
    expect(resolveEffectiveUsage(person, null)).toEqual(
      resolveEffectiveUsage(person, EMPTY),
    );
  });
});

describe("resolveEffectiveUsage — field independence (the ticket's canonical case)", () => {
  it("a person row with ONLY storage set still inherits the role's upload cap and llm cap", () => {
    const person = { ...EMPTY, storageQuotaBytes: 2n * GIB };
    const role: UsageDefaultFields = {
      storageQuotaBytes: 20n * GIB,
      maxUploadSizeMb: 75,
      llmDailyMessageCap: 300,
    };
    const effective = resolveEffectiveUsage(person, role);
    expect(effective.storageQuotaBytes).toEqual({ value: 2n * GIB, source: "person" });
    expect(effective.maxUploadSizeMb).toEqual({ value: 75, source: "role" });
    expect(effective.llmDailyMessageCap).toEqual({ value: 300, source: "role" });
  });

  it("mixed the other way: role storage default under a person upload override", () => {
    const person = { ...EMPTY, maxUploadSizeMb: 5 };
    const role = { ...EMPTY, storageQuotaBytes: 7n * GIB };
    const effective = resolveEffectiveUsage(person, role);
    expect(effective.storageQuotaBytes).toEqual({ value: 7n * GIB, source: "role" });
    expect(effective.maxUploadSizeMb).toEqual({ value: 5, source: "person" });
    expect(effective.llmDailyMessageCap).toEqual({ value: null, source: "default" });
  });
});

describe("resolveEffectiveUsage — BigInt handling", () => {
  it("storageQuotaBytes stays a real bigint through resolution (string-encoded only at the API boundary)", () => {
    const role = { ...EMPTY, storageQuotaBytes: 5368709120n };
    const effective = resolveEffectiveUsage(null, role);
    expect(typeof effective.storageQuotaBytes.value).toBe("bigint");
    expect(effective.storageQuotaBytes.value).toBe(5368709120n);
    // The wire encoding every caller applies (ADR-029 §8 BigInt-as-string).
    expect(effective.storageQuotaBytes.value?.toString()).toBe("5368709120");
  });

  it("bigint values beyond Number.MAX_SAFE_INTEGER survive undamaged", () => {
    const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2 — breaks if coerced via Number
    const effective = resolveEffectiveUsage({ ...EMPTY, storageQuotaBytes: big }, null);
    expect(effective.storageQuotaBytes.value).toBe(big);
    expect(effective.storageQuotaBytes.value?.toString()).toBe("9007199254740993");
  });
});

describe("resolveEffectiveUsage — zero-AccessRole-rows invariant (today's production)", () => {
  it("with no role, resolution is person-field ?? box default — source never 'role'", () => {
    const person = { ...EMPTY, maxUploadSizeMb: 30 };
    const effective = resolveEffectiveUsage(person, null);
    expect(effective.maxUploadSizeMb).toEqual({ value: 30, source: "person" });
    expect(effective.storageQuotaBytes).toEqual({ value: null, source: "default" });
    expect(effective.llmDailyMessageCap).toEqual({ value: null, source: "default" });
  });

  it("with no person row AND no role, every field is the box default", () => {
    const effective = resolveEffectiveUsage(null, null);
    expect(effective).toEqual({
      storageQuotaBytes: { value: null, source: "default" },
      maxUploadSizeMb: { value: null, source: "default" },
      llmDailyMessageCap: { value: null, source: "default" },
    });
  });
});

describe("getEffectiveUsage — prisma fetch wrapper", () => {
  function buildPrisma(opts: {
    policy?: UsageDefaultFields | null;
    user?: { accessRole: UsageDefaultFields | null } | null;
  }) {
    return {
      userUsagePolicy: {
        findUnique: vi.fn().mockResolvedValue(opts.policy ?? null),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(opts.user ?? null),
      },
    } as unknown as PrismaClient;
  }

  it("resolves person + role reads into one effective policy", async () => {
    const prisma = buildPrisma({
      policy: { ...EMPTY, maxUploadSizeMb: 10 },
      user: { accessRole: { ...EMPTY, storageQuotaBytes: 3n * GIB, maxUploadSizeMb: 80 } },
    });
    const effective = await getEffectiveUsage(prisma, "u1");
    expect(effective.maxUploadSizeMb).toEqual({ value: 10, source: "person" });
    expect(effective.storageQuotaBytes).toEqual({ value: 3n * GIB, source: "role" });
  });

  it("a user with accessRoleId null (today's world) resolves person ?? default", async () => {
    const prisma = buildPrisma({
      policy: { ...EMPTY, storageQuotaBytes: 1n * GIB },
      user: { accessRole: null },
    });
    const effective = await getEffectiveUsage(prisma, "u1");
    expect(effective.storageQuotaBytes).toEqual({ value: 1n * GIB, source: "person" });
    expect(effective.maxUploadSizeMb).toEqual({ value: null, source: "default" });
  });

  it("a missing user row degrades to all box defaults (deleted-mid-request race; never throws)", async () => {
    const prisma = buildPrisma({ policy: null, user: null });
    const effective = await getEffectiveUsage(prisma, "gone");
    expect(effective).toEqual({
      storageQuotaBytes: { value: null, source: "default" },
      maxUploadSizeMb: { value: null, source: "default" },
      llmDailyMessageCap: { value: null, source: "default" },
    });
  });

  it("selects only the three usage-default fields from the role (no over-fetch)", async () => {
    const prisma = buildPrisma({ policy: null, user: { accessRole: null } });
    await getEffectiveUsage(prisma, "u1");
    expect((prisma.user.findUnique as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: {
        accessRole: {
          select: {
            storageQuotaBytes: true,
            maxUploadSizeMb: true,
            llmDailyMessageCap: true,
          },
        },
      },
    });
    expect(
      (prisma.userUsagePolicy.findUnique as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: {
        storageQuotaBytes: true,
        maxUploadSizeMb: true,
        llmDailyMessageCap: true,
      },
    });
  });
});
