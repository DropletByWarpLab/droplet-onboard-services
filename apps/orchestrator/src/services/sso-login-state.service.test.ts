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

/**
 * Minimal recursive evaluator for the Prisma `where` shapes the service
 * emits: OR/AND, `{ id: { in } }`, and `{ <dateCol>: null | { lt } | { gt }
 * | { not: null } }`. Enough to let the in-memory mock honour the batched
 * prune's find/delete queries (mirrors audit-retention-purge.service.test's
 * in-memory table sim).
 */
function rowMatches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((c) => rowMatches(row, c))) return false;
    } else if (key === "AND") {
      if (!(cond as any[]).every((c) => rowMatches(row, c))) return false;
    } else if (cond === null) {
      if (row[key] !== null) return false;
    } else if (typeof cond === "object") {
      const c = cond as any;
      const v = row[key];
      if ("in" in c && !c.in.includes(v)) return false;
      if ("lt" in c && !(v !== null && v < c.lt)) return false;
      if ("gt" in c && !(v !== null && v > c.gt)) return false;
      if ("not" in c && c.not === null && v === null) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

function createPrismaMock(seed: StateRow[] = []) {
  let rows: StateRow[] = [...seed];
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
    // Batched-prune surface: select the next oldest-first id batch matching
    // the prune predicate (createdAt asc, bounded by take), then delete by id.
    findMany: vi.fn(async ({ where, orderBy, take, select }: any) => {
      let matched = rows.filter((r) => rowMatches(r, where));
      if (orderBy?.createdAt === "asc") {
        matched = [...matched].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
      }
      if (typeof take === "number") matched = matched.slice(0, take);
      return matched.map((r) => (select?.id ? { id: r.id } : r));
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = rows.length;
      rows = rows.filter((r) => !rowMatches(r, where));
      return { count: before - rows.length };
    }),
  };
  self._rows = () => rows;
  return self;
}

import {
  createLoginState,
  consumeLoginState,
  pruneExpiredLoginStates,
  SSO_LOGIN_STATE_PRUNE_GRACE_MS,
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

describe("pruneExpiredLoginStates", () => {
  const HOUR = 60 * 60 * 1000;

  function seedRow(id: string, over: Partial<StateRow> = {}): StateRow {
    return {
      id,
      state: `state-${id}`,
      nonce: `nonce-${id}`,
      codeVerifier: `verifier-${id}`,
      provider: "google",
      returnTo: "/",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
      ...over,
    };
  }

  it("deletes consumed-past-grace and unconsumed-expired rows, keeps live rows", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - HOUR);
    const future = new Date(now.getTime() + HOUR);
    const prisma = createPrismaMock([
      // consumed a while ago (past grace) → prune
      seedRow("consumed-old", { consumedAt: past, expiresAt: future }),
      // never consumed, expired → prune
      seedRow("expired", { consumedAt: null, expiresAt: past }),
      // live, unconsumed → keep
      seedRow("live", { consumedAt: null, expiresAt: future }),
    ]);

    const deleted = await pruneExpiredLoginStates(prisma, { now });

    expect(deleted).toBe(2);
    const survivors = prisma._rows().map((r: StateRow) => r.id);
    expect(survivors).toEqual(["live"]);
  });

  it("spares a row consumed within the grace window (TOCTOU guard vs consumeLoginState's claim-then-read)", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + HOUR);
    // consumedAt is inside the grace window — a concurrent consumeLoginState
    // may still be mid-read of this row, so the prune must not delete it yet.
    const justConsumed = new Date(
      now.getTime() - Math.floor(SSO_LOGIN_STATE_PRUNE_GRACE_MS / 2),
    );
    const prisma = createPrismaMock([
      seedRow("just-consumed", { consumedAt: justConsumed, expiresAt: future }),
    ]);

    const deleted = await pruneExpiredLoginStates(prisma, { now });

    expect(deleted).toBe(0);
    expect(prisma._rows().map((r: StateRow) => r.id)).toEqual(["just-consumed"]);
  });

  it("does NOT prune a freshly-consumed row even when it is also expired (grace beats expiry)", async () => {
    const now = new Date();
    // Row consumed just now but whose expiry already passed (consumed in the
    // final seconds of its window). Grace must still protect it from the race.
    const justConsumed = new Date(
      now.getTime() - Math.floor(SSO_LOGIN_STATE_PRUNE_GRACE_MS / 2),
    );
    const prisma = createPrismaMock([
      seedRow("edge", {
        consumedAt: justConsumed,
        expiresAt: new Date(now.getTime() - 1000),
      }),
    ]);

    const deleted = await pruneExpiredLoginStates(prisma, { now });

    expect(deleted).toBe(0);
    expect(prisma._rows()).toHaveLength(1);
  });

  it("drains a backlog larger than one batch via multiple bounded deletes", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - HOUR);
    const rows = Array.from({ length: 25 }, (_, i) =>
      seedRow(`old-${i}`, {
        consumedAt: past,
        createdAt: new Date(now.getTime() - (25 - i) * 1000),
      }),
    );
    const prisma = createPrismaMock(rows);

    const deleted = await pruneExpiredLoginStates(prisma, { now, batchSize: 10 });

    expect(deleted).toBe(25);
    expect(prisma._rows()).toHaveLength(0);
    // 25 rows / batch 10 → 3 bounded deletes (10 + 10 + 5), never one 25-row
    // statement that could scan the whole backlog inside the 60 s tx.
    expect(prisma.ssoLoginState.deleteMany).toHaveBeenCalledTimes(3);
    for (const call of prisma.ssoLoginState.deleteMany.mock.calls) {
      expect(call[0].where.id.in.length).toBeLessThanOrEqual(10);
    }
  });

  it("caps total rows per run so a huge first-run backlog can't wedge the 60 s transaction", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - HOUR);
    const rows = Array.from({ length: 100 }, (_, i) =>
      seedRow(`old-${i}`, {
        consumedAt: past,
        createdAt: new Date(now.getTime() - (100 - i) * 1000),
      }),
    );
    const prisma = createPrismaMock(rows);

    const deleted = await pruneExpiredLoginStates(prisma, {
      now,
      batchSize: 10,
      maxRowsPerRun: 30,
    });

    expect(deleted).toBe(30);
    // 70 rows remain for subsequent nightly runs → the backlog drains safely.
    expect(prisma._rows()).toHaveLength(70);
    expect(prisma.ssoLoginState.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("no-ops on an empty table", async () => {
    const prisma = createPrismaMock([]);
    const deleted = await pruneExpiredLoginStates(prisma);
    expect(deleted).toBe(0);
    expect(prisma.ssoLoginState.deleteMany).not.toHaveBeenCalled();
  });
});
