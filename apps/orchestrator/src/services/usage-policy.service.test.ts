/**
 * WARP-1271 (T19a) — usage-policy service tests.
 *
 * Covers: upsert (create + update paths), NC quota pushdown success/failure
 * (quotaSyncState transitions), no-nextcloud-account-yet deferral, and the
 * GET-with-usage read path (policy + display-only used bytes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: { NEXTCLOUD_URL: "http://nextcloud.test" },
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
}));

const { ncUpdateUserMock, ncGetUserQuotaAdminMock } = vi.hoisted(() => ({
  ncUpdateUserMock: vi.fn(),
  ncGetUserQuotaAdminMock: vi.fn(),
}));
vi.mock("./nextcloud.client.js", () => ({
  ncUpdateUser: ncUpdateUserMock,
  ncGetUserQuotaAdmin: ncGetUserQuotaAdminMock,
}));

import {
  upsertUsagePolicy,
  getUsagePolicyWithUsage,
  TargetUserNotFoundError,
} from "./usage-policy.service.js";

function createMockPrisma() {
  const users = new Map<string, any>();
  const policies = new Map<string, any>();

  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: any) => {
      const u = users.get(where.id);
      return u ? { ...u } : null;
    }),
  };
  self.userUsagePolicy = {
    findUnique: vi.fn(async ({ where }: any) => {
      const p = policies.get(where.userId);
      return p ? { ...p } : null;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = policies.get(where.userId);
      const row = existing
        ? { ...existing, ...update }
        : { ...create, updatedAt: new Date() };
      policies.set(where.userId, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const existing = policies.get(where.userId);
      if (!existing) throw new Error(`no policy for ${where.userId}`);
      const row = { ...existing, ...data };
      policies.set(where.userId, row);
      return { ...row };
    }),
  };
  return { self, users, policies };
}

describe("upsertUsagePolicy", () => {
  let prisma: ReturnType<typeof createMockPrisma>["self"];
  let users: Map<string, any>;
  let policies: Map<string, any>;

  beforeEach(() => {
    const built = createMockPrisma();
    prisma = built.self;
    users = built.users;
    policies = built.policies;
    ncUpdateUserMock.mockReset();
    ncGetUserQuotaAdminMock.mockReset();
  });

  it("throws TargetUserNotFoundError for an unknown user", async () => {
    await expect(
      upsertUsagePolicy(prisma as PrismaClient, "ghost", "actor-1", {
        storageQuotaBytes: 1024n,
      }),
    ).rejects.toBeInstanceOf(TargetUserNotFoundError);
  });

  it("creates a policy row and pushes the quota to Nextcloud (synced)", async () => {
    users.set("u1", { id: "u1", username: "alice", nextcloudUsername: "alice" });
    ncUpdateUserMock.mockResolvedValue(undefined);

    const { policy, pushed } = await upsertUsagePolicy(
      prisma as PrismaClient,
      "u1",
      "owner-1",
      { storageQuotaBytes: 5_000_000_000n },
    );

    expect(pushed).toBe(true);
    expect(policy.quotaSyncState).toBe("synced");
    expect(ncUpdateUserMock).toHaveBeenCalledWith(
      "basic:dGVzdDp0ZXN0",
      "alice",
      "quota",
      "5000000000 B",
    );
  });

  it("storageQuotaBytes: null pushes the OCS 'none' (unlimited) sentinel", async () => {
    users.set("u1", { id: "u1", username: "alice", nextcloudUsername: "alice" });
    ncUpdateUserMock.mockResolvedValue(undefined);

    await upsertUsagePolicy(prisma as PrismaClient, "u1", "owner-1", {
      storageQuotaBytes: null,
    });

    expect(ncUpdateUserMock).toHaveBeenCalledWith(
      "basic:dGVzdDp0ZXN0",
      "alice",
      "quota",
      "none",
    );
  });

  it("NC pushdown failure leaves quotaSyncState=failed (reconciler retries)", async () => {
    users.set("u1", { id: "u1", username: "alice", nextcloudUsername: "alice" });
    ncUpdateUserMock.mockRejectedValue(new Error("nc unreachable"));

    const { policy, pushed } = await upsertUsagePolicy(
      prisma as PrismaClient,
      "u1",
      "owner-1",
      { storageQuotaBytes: 1_000n },
    );

    expect(pushed).toBe(false);
    expect(policy.quotaSyncState).toBe("failed");
  });

  it("no Nextcloud account yet → leaves quotaSyncState=pending, never calls ncUpdateUser", async () => {
    users.set("u1", { id: "u1", username: "alice", nextcloudUsername: null });

    const { policy, pushed } = await upsertUsagePolicy(
      prisma as PrismaClient,
      "u1",
      "owner-1",
      { storageQuotaBytes: 1_000n },
    );

    expect(pushed).toBe(false);
    expect(policy.quotaSyncState).toBe("pending");
    expect(ncUpdateUserMock).not.toHaveBeenCalled();
  });

  it("maxUploadSizeMb-only update never touches Nextcloud (orchestrator-local field)", async () => {
    users.set("u1", { id: "u1", username: "alice", nextcloudUsername: "alice" });
    policies.set("u1", {
      userId: "u1",
      storageQuotaBytes: null,
      quotaSyncState: "synced",
      maxUploadSizeMb: null,
      updatedBy: "owner-0",
      updatedAt: new Date(),
    });

    const { pushed } = await upsertUsagePolicy(prisma as PrismaClient, "u1", "owner-1", {
      maxUploadSizeMb: 250,
    });

    expect(ncUpdateUserMock).not.toHaveBeenCalled();
    expect(pushed).toBe(true); // already synced from before; unaffected
    expect(policies.get("u1")!.maxUploadSizeMb).toBe(250);
  });
});

describe("getUsagePolicyWithUsage", () => {
  let prisma: ReturnType<typeof createMockPrisma>["self"];
  let users: Map<string, any>;
  let policies: Map<string, any>;

  beforeEach(() => {
    const built = createMockPrisma();
    prisma = built.self;
    users = built.users;
    policies = built.policies;
    ncGetUserQuotaAdminMock.mockReset();
  });

  it("throws TargetUserNotFoundError for an unknown user", async () => {
    await expect(
      getUsagePolicyWithUsage(prisma as PrismaClient, "ghost"),
    ).rejects.toBeInstanceOf(TargetUserNotFoundError);
  });

  it("returns policy:null when no row has ever been written", async () => {
    users.set("u1", { id: "u1", nextcloudUsername: "alice" });
    ncGetUserQuotaAdminMock.mockResolvedValue({ used: 123, free: null, total: null, quota: null });

    const { policy, usedBytes } = await getUsagePolicyWithUsage(prisma as PrismaClient, "u1");
    expect(policy).toBeNull();
    expect(usedBytes).toBe(123n);
  });

  it("degrades to usedBytes:null when the NC quota read fails (never fabricates 0)", async () => {
    users.set("u1", { id: "u1", nextcloudUsername: "alice" });
    ncGetUserQuotaAdminMock.mockRejectedValue(new Error("nc down"));

    const { usedBytes } = await getUsagePolicyWithUsage(prisma as PrismaClient, "u1");
    expect(usedBytes).toBeNull();
  });

  it("usedBytes:null when the user has no Nextcloud account yet", async () => {
    users.set("u1", { id: "u1", nextcloudUsername: null });

    const { usedBytes } = await getUsagePolicyWithUsage(prisma as PrismaClient, "u1");
    expect(usedBytes).toBeNull();
    expect(ncGetUserQuotaAdminMock).not.toHaveBeenCalled();
  });
});
