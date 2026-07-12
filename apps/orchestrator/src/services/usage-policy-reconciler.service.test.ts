/**
 * WARP-1271 (T19a) — usage-policy reconciler sweep tests.
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

function buildPrisma(
  policies: Array<{ userId: string; storageQuotaBytes: bigint | null; quotaSyncState: string }>,
  users: Record<string, { nextcloudUsername: string | null }>,
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
      return u ? { ...u } : null;
    }),
  };
  return { self, policyRows };
}

describe("sweepUsagePolicies", () => {
  beforeEach(() => {
    ncUpdateUserMock.mockReset();
  });

  it("re-pushes a pending row and marks it synced on success", async () => {
    const { self, policyRows } = buildPrisma(
      [{ userId: "u1", storageQuotaBytes: 5_000n, quotaSyncState: "pending" }],
      { u1: { nextcloudUsername: "alice" } },
    );
    ncUpdateUserMock.mockResolvedValue(undefined);

    const result = await sweepUsagePolicies(self as PrismaClient, "basic:token");

    expect(result).toEqual({ usagePoliciesSwept: 1, usagePoliciesSynced: 1, usagePoliciesFailed: 0 });
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
    // null quota pushes the OCS "none" (unlimited) sentinel.
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

    expect(result).toEqual({ usagePoliciesSwept: 0, usagePoliciesSynced: 0, usagePoliciesFailed: 0 });
    expect(ncUpdateUserMock).not.toHaveBeenCalled();
  });
});
