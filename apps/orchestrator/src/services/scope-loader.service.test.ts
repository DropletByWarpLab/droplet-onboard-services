/**
 * WARP-455 — scope-loader singleton unit tests.
 *
 * Exercises `loadUserEffectiveScopes` in isolation against a stubbed
 * Prisma (no DB), mirroring `activity.service.test.ts`. Proves:
 *   - throws before init (→ 500 in the middleware, fail-closed)
 *   - returns ScopeBinding rows as a Set
 *   - a swept-EXPIRED guest holds NO scopes (explicit-enum time-box)
 *   - ACTIVE / no-GuestExpiry users get their bindings normally
 *   - the loader queries scopeBinding.findMany with the passed userId
 *   - initScopeLoader is idempotent
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  initScopeLoader,
  loadUserEffectiveScopes,
  _setScopeLoaderPrismaForTests,
} from "./scope-loader.service.js";

type GuestExpiryFixture = { status: "ACTIVE" | "EXPIRED" } | null;
type ScopeRowFixture = { scope: string }[];

function makePrismaFake(opts: {
  expiry?: GuestExpiryFixture;
  bindings?: ScopeRowFixture;
}) {
  return {
    guestExpiry: {
      findUnique: vi.fn(async () => opts.expiry ?? null),
    },
    scopeBinding: {
      findMany: vi.fn(async () => opts.bindings ?? []),
    },
  };
}

beforeEach(() => {
  // Reset the module-scoped singleton between cases.
  _setScopeLoaderPrismaForTests(null);
  vi.clearAllMocks();
});

describe("scope-loader.service — loadUserEffectiveScopes", () => {
  it("throws before initScopeLoader is called (middleware maps to 500)", async () => {
    // Singleton is null (reset in beforeEach) — fail-closed throw, NOT
    // a silent empty Set that would 403 a legitimate user.
    await expect(loadUserEffectiveScopes("u1")).rejects.toThrow(
      /not initialised/i,
    );
  });

  it("returns the user's ScopeBinding scopes as a Set", async () => {
    const prisma = makePrismaFake({
      bindings: [{ scope: "team" }, { scope: "finance" }],
    });
    _setScopeLoaderPrismaForTests(prisma as unknown as PrismaClient);

    const scopes = await loadUserEffectiveScopes("u1");

    expect(scopes).toBeInstanceOf(Set);
    expect([...scopes].sort()).toEqual(["finance", "team"]);
  });

  it("returns empty Set when a guest's GuestExpiry.status is EXPIRED (time-box revokes all scopes)", async () => {
    // Even though the user still has stored bindings, a swept-EXPIRED
    // guest holds NO effective scopes. Explicit-enum check, never
    // derived from expiresAt.
    const prisma = makePrismaFake({
      expiry: { status: "EXPIRED" },
      bindings: [{ scope: "team" }, { scope: "exec_only" }],
    });
    _setScopeLoaderPrismaForTests(prisma as unknown as PrismaClient);

    const scopes = await loadUserEffectiveScopes("guest-1");

    expect(scopes.size).toBe(0);
    // The binding query must be short-circuited — no point reading rows
    // we're going to discard.
    expect(prisma.scopeBinding.findMany).not.toHaveBeenCalled();
  });

  it("returns bindings normally when GuestExpiry.status is ACTIVE", async () => {
    const prisma = makePrismaFake({
      expiry: { status: "ACTIVE" },
      bindings: [{ scope: "team" }],
    });
    _setScopeLoaderPrismaForTests(prisma as unknown as PrismaClient);

    const scopes = await loadUserEffectiveScopes("guest-2");

    expect([...scopes]).toEqual(["team"]);
  });

  it("returns bindings normally when the user has no GuestExpiry row (non-guest)", async () => {
    const prisma = makePrismaFake({
      expiry: null,
      bindings: [{ scope: "engineering" }],
    });
    _setScopeLoaderPrismaForTests(prisma as unknown as PrismaClient);

    const scopes = await loadUserEffectiveScopes("family-1");

    expect([...scopes]).toEqual(["engineering"]);
  });

  it("queries scopeBinding.findMany with the passed userId", async () => {
    const prisma = makePrismaFake({ bindings: [] });
    _setScopeLoaderPrismaForTests(prisma as unknown as PrismaClient);

    await loadUserEffectiveScopes("alice-id");

    expect(prisma.guestExpiry.findUnique).toHaveBeenCalledWith({
      where: { userId: "alice-id" },
    });
    expect(prisma.scopeBinding.findMany).toHaveBeenCalledWith({
      where: { userId: "alice-id" },
      select: { scope: true },
    });
  });

  it("initScopeLoader is idempotent (second call does not rebind)", async () => {
    const first = makePrismaFake({ bindings: [{ scope: "team" }] });
    const second = makePrismaFake({ bindings: [{ scope: "finance" }] });

    initScopeLoader(first as unknown as PrismaClient);
    // Second call must be a no-op — the singleton stays bound to `first`.
    initScopeLoader(second as unknown as PrismaClient);

    const scopes = await loadUserEffectiveScopes("u1");

    expect([...scopes]).toEqual(["team"]);
    expect(first.scopeBinding.findMany).toHaveBeenCalledTimes(1);
    expect(second.scopeBinding.findMany).not.toHaveBeenCalled();
  });
});
