/**
 * WARP-1271 (T19a) — usage-policy reconciler sweep tests.
 * WARP-1531 (RBAC v2 T7) — role-default quota convergence:
 *
 *   - pass 1 (row sweep, unchanged cadence): pending/failed rows push the
 *     EFFECTIVE quota — person field ?? role default ?? "none" — so a row
 *     whose storage field is unset converges onto its role's default;
 *   - pass 2 (stateless role pass): users whose AccessRole carries a
 *     storage default and whose own field is unset get that default pushed
 *     EVERY sweep — no new columns, no new sync states; a role-default
 *     change converges affected users on the next tick by construction.
 *
 * Zero-AccessRole-rows invariant (production today): with no role rows the
 * original four specs below must behave byte-identically to pre-1531 main
 * — same pushes, same states — with every roleDefaultQuotas* counter 0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { ncUpdateUserMock } = vi.hoisted(() => ({
  ncUpdateUserMock: vi.fn(),
}));
vi.mock("./nextcloud.client.js", () => ({
  ncUpdateUser: ncUpdateUserMock,
}));

import { sweepUsagePolicies } from "./usage-policy-reconciler.service.js";

interface StubUser {
  nextcloudUsername: string | null;
  accessRole?: { storageQuotaBytes: bigint | null } | null;
}

function buildPrisma(
  policies: Array<{ userId: string; storageQuotaBytes: bigint | null; quotaSyncState: string }>,
  users: Record<string, StubUser>,
) {
  const policyRows = new Map(policies.map((p) => [p.userId, { ...p }]));
  const self: any = {};
  self.userUsagePolicy = {
    findMany: vi.fn(async ({ where }: any) => {
      return [...policyRows.values()].filter((p) => where.quotaSyncState.in.includes(p.quotaSyncState));
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = policyRows.get(where.userId);
      if (!row) throw new Error(`no such policy ${where.userId}`);
      Object.assign(row, data);
      return { ...row };
    }),
  };
  self.user = {
    findUnique: vi.fn(async ({ where }: any) => {
      const u = users[where.id];
      return u ? { nextcloudUsername: u.nextcloudUsername, accessRole: u.accessRole ?? null } : null;
    }),
    // Emulates the pass-2 relation filter:
    //   where: { accessRole: { storageQuotaBytes: { not: null } } }
    findMany: vi.fn(async () =>
      Object.entries(users)
        .filter(([, u]) => u.accessRole?.storageQuotaBytes != null)
        .map(([id, u]) => {
          const p = policyRows.get(id);
          return {
            id,
            nextcloudUsername: u.nextcloudUsername,
            accessRole: u.accessRole ?? null,
            usagePolicy: p
              ? { storageQuotaBytes: p.storageQuotaBytes, quotaSyncState: p.quotaSyncState }
              : null,
          };
        }),
    ),
  };
  return { self, policyRows };
}

const ZERO_ROLE_COUNTS = {
  roleDefaultQuotasSwept: 0,
  roleDefaultQuotasSynced: 0,
  roleDefaultQuotasFailed: 0,
};

describe("sweepUsagePolicies", () => {
  beforeEach(() => {
    ncUpdateUserMock.mockReset();
  });

  // ── Zero-AccessRole-rows invariant: the four pre-1531 specs, unchanged ──

  it("re-pushes a pending row and marks it synced on success", async () => {
    const { self, policyRows } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 5_000n, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: "alice" } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(result).toEqual({
      usagePoliciesSwept: 1,
      usagePoliciesSynced: 1,
      usagePoliciesFailed: 0,
      ...ZERO_ROLE_COUNTS,
    });
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "5000 B");
    expect(policyRows.get("u1")!.quotaSyncState).toBe("synced");
  });

  it("retries a failed row and stays failed when NC is still down", async () => {
    const { self, policyRows } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: null, quotaSyncState: "failed" }],
      { u1: { nextcloudUsername: "alice" } },
    );
    ncUpdateUserMock.mockRejectedValue(new Error("nc unreachable"));

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(result.usagePoliciesFailed).toBe(1);
    expect(policyRows.get("u1")!.quotaSyncState).toBe("failed");
    // null quota with NO role default pushes the OCS "none" (unlimited)
    // sentinel — byte-identical to pre-1531 behavior.
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "none");
  });

  it("skips a row with no Nextcloud account yet (not an error, just retried next tick)", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 100n, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: null } },
    );

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result.usagePoliciesFailed).toBe(1);
    expect(result.usagePoliciesSynced).toBe(0);
  });

  it("ignores already-synced rows", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 100n, quotaSyncState: "synced" }],
      { u1: { nextcloudUsername: "alice" } },
    );

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(result).toEqual({
      usagePoliciesSwept: 0,
      usagePoliciesSynced: 0,
      usagePoliciesFailed: 0,
      ...ZERO_ROLE_COUNTS,
    });
    expect(ncUpdateUserMock).not.toHaveBeenCalled();
  });

  // ── WARP-1531 pass 1: pending/failed rows push the EFFECTIVE quota ──

  it("a pending row with an unset storage field pushes the ROLE default, not 'none'", async () => {
    const { self, policyRows } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: null, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 7_000n } } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "7000 B");
    expect(policyRows.get("u1")!.quotaSyncState).toBe("synced");
    expect(result.usagePoliciesSynced).toBe(1);
    // Pass 1 owned this user this tick — the stateless pass must not double-push.
    expect(result.roleDefaultQuotasSwept).toBe(0);
  });

  it("a pending row with a person value beats the role default", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 5_000n, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 7_000n } } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "5000 B");
  });

  // ── WARP-1531 pass 2: stateless role-default convergence ──

  it("a ROWLESS user with a role default gets it pushed — no policy row is created or touched", async () => {
    const { self } = buildPrisma([], {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 9_000n } },
    });
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "bob", "quota", "9000 B");
    expect(result).toEqual({
      usagePoliciesSwept: 0,
      usagePoliciesSynced: 0,
      usagePoliciesFailed: 0,
      roleDefaultQuotasSwept: 1,
      roleDefaultQuotasSynced: 1,
      roleDefaultQuotasFailed: 0,
    });
    // Stateless by design: no sync-state writes for role-managed users.
    expect(self.userUsagePolicy.update).not.toHaveBeenCalled();
  });

  it("a SYNCED row whose storage field is unset still converges onto the role default", async () => {
    const { self } = buildPrisma(
      [{ userId: "u2", storageQuotaBytes: null, quotaSyncState: "synced" }],
      { u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 9_000n } } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "bob", "quota", "9000 B");
    expect(result.roleDefaultQuotasSynced).toBe(1);
    expect(self.userUsagePolicy.update).not.toHaveBeenCalled();
  });

  it("skips a person-managed user (their own storage value wins; row lifecycle owns pushes)", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 4_000n, quotaSyncState: "synced" }],
      { u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 9_000n } } },
    );

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result.roleDefaultQuotasSwept).toBe(0);
  });

  it("a pending row with a role default is pushed exactly ONCE per tick (pass 1 owns it)", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: null, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 6_000n } } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "6000 B");
    expect(result.usagePoliciesSynced).toBe(1);
    expect(result.roleDefaultQuotasSwept).toBe(0);
  });

  it("a role-default user with no NC account yet is counted failed and retried next tick", async () => {
    const { self } = buildPrisma([], {
      u3: { nextcloudUsername: null, accessRole: { storageQuotaBytes: 8_000n } },
    });

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result.roleDefaultQuotasSwept).toBe(1);
    expect(result.roleDefaultQuotasFailed).toBe(1);
  });

  it("an NC failure on the role pass is counted failed without touching any row state", async () => {
    const { self } = buildPrisma([], {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 9_000n } },
    });
    ncUpdateUserMock.mockRejectedValue(new Error("nc unreachable"));

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(result.roleDefaultQuotasFailed).toBe(1);
    expect(result.roleDefaultQuotasSynced).toBe(0);
    expect(self.userUsagePolicy.update).not.toHaveBeenCalled();
  });

  it("STATELESS convergence: a role-default change is pushed on the very next sweep", async () => {
    const users: Record<string, StubUser> = {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 9_000n } },
    };
    const { self } = buildPrisma([], users);
    ncUpdateUserMock.mockResolvedValue(undefined);

    await sweepUsagePolicies(self as PrismaClient, "basic:token");
    users.u2.accessRole!.storageQuotaBytes = 12_000n;
    await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenNthCalledWith(1, "basic:token", "bob", "quota", "9000 B");
    expect(ncUpdateUserMock).toHaveBeenNthCalledWith(2, "basic:token", "bob", "quota", "12000 B");
  });
});
