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
  /** `state` defaults to "active" — an archived role is opted into per-test
   *  (WARP-1569), so every pre-existing spec keeps its original meaning. */
  accessRole?: { storageQuotaBytes: bigint | null; state?: string } | null;
}

/** The role as the service SELECTS it — `state` materialised so the
 *  archived-role predicate is exercised, not assumed (WARP-1569). */
function selectRole(u: StubUser) {
  if (!u.accessRole) return null;
  return { storageQuotaBytes: u.accessRole.storageQuotaBytes, state: u.accessRole.state ?? "active" };
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
    // C1 (PR #1223 review): pass 2's pre-push re-read of the person row.
    findUnique: vi.fn(async ({ where }: any) => {
      const p = policyRows.get(where.userId);
      return p
        ? { storageQuotaBytes: p.storageQuotaBytes, quotaSyncState: p.quotaSyncState }
        : null;
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
      return u ? { nextcloudUsername: u.nextcloudUsername, accessRole: selectRole(u) } : null;
    }),
    // Applies the pass-2 relation filter the service ACTUALLY sends rather
    // than a hardcoded copy of it — otherwise a missing predicate (the
    // WARP-1569 defect) can never be caught here.
    findMany: vi.fn(async ({ where }: any) =>
      Object.entries(users)
        .filter(([, u]) => {
          const role = selectRole(u);
          const pred = where?.accessRole;
          if (!pred) return true;
          if (!role) return false;
          if (pred.storageQuotaBytes?.not === null && role.storageQuotaBytes == null) return false;
          if (pred.state !== undefined && role.state !== pred.state) return false;
          return true;
        })
        .map(([id, u]) => {
          const p = policyRows.get(id);
          return {
            id,
            nextcloudUsername: u.nextcloudUsername,
            accessRole: selectRole(u),
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

  it("C1: a concurrent person PUT between the roster snapshot and the push is honored — the stale role default is NOT pushed", async () => {
    // PR #1223 review (C1). Timeline this pins:
    //   1. pass 2 snapshots the roster — u2 is rowless with a 10 GB role
    //      default;
    //   2. an admin PUTs a 25 GB person quota; the inline push lands and the
    //      row commits `synced`;
    //   3. the loop reaches u2. Without the pre-push re-read it would push
    //      the STALE 10 GB role default — NC then enforces 10 GB while
    //      Prisma says 25 GB `synced`, and NOTHING heals it (pass 1 skips
    //      synced rows, pass 2 skips person-set users) — permanent drift
    //      the roster masks.
    const { self } = buildPrisma([], {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 10n * 1024n ** 3n } },
    });
    // The re-read (step 3) sees the row the concurrent PUT (step 2) just
    // committed: person-set, synced.
    (self.userUsagePolicy.findUnique as any).mockResolvedValueOnce({
      storageQuotaBytes: 25n * 1024n ** 3n,
      quotaSyncState: "synced",
    });
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result.roleDefaultQuotasSwept).toBe(0);
    expect(result.roleDefaultQuotasSynced).toBe(0);
    expect(result.roleDefaultQuotasFailed).toBe(0);
  });

  it("C1: a person row gone PENDING mid-sweep is left to its own lifecycle (no role push)", async () => {
    // Same race, earlier phase: the PUT committed `pending` (inline push
    // still in flight or deferred). The row lifecycle owns the next push;
    // pass 2 must stand down exactly like the rowSweptUserIds dedupe.
    const { self } = buildPrisma([], {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 10n * 1024n ** 3n } },
    });
    (self.userUsagePolicy.findUnique as any).mockResolvedValueOnce({
      storageQuotaBytes: null,
      quotaSyncState: "pending",
    });

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result.roleDefaultQuotasSwept).toBe(0);
  });

  it("N4 pass 1: one user's NC failure never aborts the sweep — the next row still pushes", async () => {
    const { self, policyRows } = buildPrisma(
      [
        { userId: "u1", storageQuotaBytes: 1_000n, quotaSyncState: "pending" },
        { userId: "u2", storageQuotaBytes: 2_000n, quotaSyncState: "pending" },
      ],
      { u1: { nextcloudUsername: "alice" }, u2: { nextcloudUsername: "bob" } },
    );
    ncUpdateUserMock.mockImplementation(async (_token: string, ncUser: string) => {
      if (ncUser === "alice") throw new Error("nc choked on alice");
    });

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "1000 B");
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "bob", "quota", "2000 B");
    expect(result.usagePoliciesSwept).toBe(2);
    expect(result.usagePoliciesSynced).toBe(1);
    expect(result.usagePoliciesFailed).toBe(1);
    expect(policyRows.get("u1")!.quotaSyncState).toBe("failed");
    expect(policyRows.get("u2")!.quotaSyncState).toBe("synced");
  });

  it("N4 pass 2: one user's NC failure never aborts the role pass — the next user still pushes", async () => {
    const { self } = buildPrisma([], {
      u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 3_000n } },
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 4_000n } },
    });
    ncUpdateUserMock.mockImplementation(async (_token: string, ncUser: string) => {
      if (ncUser === "alice") throw new Error("nc choked on alice");
    });

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "3000 B");
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "bob", "quota", "4000 B");
    expect(result.roleDefaultQuotasSwept).toBe(2);
    expect(result.roleDefaultQuotasSynced).toBe(1);
    expect(result.roleDefaultQuotasFailed).toBe(1);
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

  // ── WARP-1569: an ARCHIVED role is inert — it manages nobody's quota ──

  it("pass 2: an ARCHIVED role's storage default is never pushed", async () => {
    const { self } = buildPrisma([], {
      u2: {
        nextcloudUsername: "bob",
        accessRole: { storageQuotaBytes: 9_000n, state: "archived" },
      },
    });

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      usagePoliciesSwept: 0,
      usagePoliciesSynced: 0,
      usagePoliciesFailed: 0,
      ...ZERO_ROLE_COUNTS,
    });
  });

  it("pass 2: archiving a role stops the pushes that were landing the tick before", async () => {
    const users: Record<string, StubUser> = {
      u2: { nextcloudUsername: "bob", accessRole: { storageQuotaBytes: 9_000n } },
    };
    const { self } = buildPrisma([], users);
    ncUpdateUserMock.mockResolvedValue(undefined);

    await sweepUsagePolicies(self as PrismaClient, "basic:token");
    users.u2.accessRole!.state = "archived";
    const after = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(after.roleDefaultQuotasSwept).toBe(0);
  });

  it("pass 2: an active sibling still converges while an archived role stands down", async () => {
    const { self } = buildPrisma([], {
      u1: { nextcloudUsername: "alice", accessRole: { storageQuotaBytes: 3_000n } },
      u2: {
        nextcloudUsername: "bob",
        accessRole: { storageQuotaBytes: 4_000n, state: "archived" },
      },
    });
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "3000 B");
    expect(result.roleDefaultQuotasSwept).toBe(1);
  });

  it("pass 1: a pending row under an ARCHIVED role falls through to the box default", async () => {
    // Same treatment a role-LESS user with an unset storage field already
    // gets: the row lifecycle still owns the push, but the archived role
    // contributes nothing to the effective value.
    const { self, policyRows } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: null, quotaSyncState: "pending" }],
      {
        u1: {
          nextcloudUsername: "alice",
          accessRole: { storageQuotaBytes: 7_000n, state: "archived" },
        },
      },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledTimes(1);
    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "none");
    expect(policyRows.get("u1")!.quotaSyncState).toBe("synced");
    expect(result.usagePoliciesSynced).toBe(1);
  });

  it("pass 1: a person value under an ARCHIVED role is still their own to push", async () => {
    const { self } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 5_000n, quotaSyncState: "pending" }],
      {
        u1: {
          nextcloudUsername: "alice",
          accessRole: { storageQuotaBytes: 7_000n, state: "archived" },
        },
      },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(ncUpdateUserMock).toHaveBeenCalledWith("basic:token", "alice", "quota", "5000 B");
  });
});
