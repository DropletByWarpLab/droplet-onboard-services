/**
 * ADR-013 (SSO OIDC) — server-side single-use, time-bound login state.
 *
 * createLoginState persists the per-attempt state/nonce/codeVerifier with a
 * short expiry. consumeLoginState ATOMICALLY claims the row by `state`
 * (CSRF), rejecting:
 *   - an unknown state (forged/foreign callback),
 *   - an already-consumed state (replay — single-use),
 *   - an expired state (stale flow).
 *
 * The claim uses a conditional updateMany (consumedAt IS NULL AND expiresAt
 * in the future) so two concurrent callbacks can't both win — exactly one
 * gets count===1. Same single-use idiom as claimRefreshRotation /
 * UserInvite.acceptedAt elsewhere in this codebase.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface StateRow {
  id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  provider: string;
  returnTo: string;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function createPrismaMock(seed: StateRow[] = []) {
  const rows: StateRow[] = [...seed];
  const self: any = {};
  self.ssoLoginState = {
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: StateRow = {
        id: data.id ?? `sls-${rows.length + 1}`,
        state: data.state,
        nonce: data.nonce,
        codeVerifier: data.codeVerifier,
        provider: data.provider,
        returnTo: data.returnTo ?? "/",
        consumedAt: null,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      };
      rows.push(row);
      return row;
    }),
    // Conditional claim: only flips rows matching the where filter.
    updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      let count = 0;
      for (const r of rows) {
        if (r.state !== where.state) continue;
        if (where.consumedAt === null && r.consumedAt !== null) continue;
        if (where.expiresAt?.gt && !(r.expiresAt > where.expiresAt.gt)) continue;
        r.consumedAt = data.consumedAt;
        count++;
      }
      return { count };
    }),
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      return rows.find((r) => r.state === where.state) ?? null;
    }),
  };
  self._rows = rows;
  return self;
}

import {
  createLoginState,
  consumeLoginState,
} from "./sso-login-state.service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function freshRow(over: Partial<StateRow> = {}): StateRow {
  return {
    id: "sls-1",
    state: "state-aaa",
    nonce: "nonce-aaa",
    codeVerifier: "verifier-aaa",
    provider: "google",
    returnTo: "/",
    consumedAt: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    ...over,
  };
}

describe("createLoginState", () => {
  it("persists state/nonce/codeVerifier/provider with a future expiry", async () => {
    const prisma = createPrismaMock();
    const row = await createLoginState(prisma, {
      provider: "google",
      state: "state-aaa",
      nonce: "nonce-aaa",
      codeVerifier: "verifier-aaa",
      returnTo: "/home",
      ttlSeconds: 600,
    });
    expect(row.state).toBe("state-aaa");
    expect(prisma.ssoLoginState.create).toHaveBeenCalledTimes(1);
    const data = prisma.ssoLoginState.create.mock.calls[0]![0].data;
    expect(data.nonce).toBe("nonce-aaa");
    expect(data.codeVerifier).toBe("verifier-aaa");
    expect(data.provider).toBe("google");
    expect(data.returnTo).toBe("/home");
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("consumeLoginState", () => {
  it("claims a valid, unconsumed, unexpired row exactly once", async () => {
    const prisma = createPrismaMock([freshRow()]);
    const claimed = await consumeLoginState(prisma, "state-aaa");
    expect(claimed).not.toBeNull();
    expect(claimed!.nonce).toBe("nonce-aaa");
    expect(claimed!.codeVerifier).toBe("verifier-aaa");
    expect(claimed!.provider).toBe("google");
    // The conditional claim ran with consumedAt-null + expiresAt-future guard.
    const where = prisma.ssoLoginState.updateMany.mock.calls[0]![0].where;
    expect(where.state).toBe("state-aaa");
    expect(where.consumedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("returns null for an unknown state (forged/foreign callback)", async () => {
    const prisma = createPrismaMock([freshRow()]);
    const claimed = await consumeLoginState(prisma, "state-nope");
    expect(claimed).toBeNull();
  });

  it("returns null on replay — a second consume of the same state fails", async () => {
    const prisma = createPrismaMock([freshRow()]);
    const first = await consumeLoginState(prisma, "state-aaa");
    expect(first).not.toBeNull();
    const second = await consumeLoginState(prisma, "state-aaa");
    expect(second).toBeNull();
  });

  it("returns null for an expired state (stale flow)", async () => {
    const prisma = createPrismaMock([
      freshRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    const claimed = await consumeLoginState(prisma, "state-aaa");
    expect(claimed).toBeNull();
  });
});
