/**
 * WARP-1570 — self-tests for the shared route-test Prisma transaction seam.
 *
 * The harness this file guards is the promoted version of the stub the RBAC
 * v2 T3 branch grew locally (routes/access.routes.test.ts +
 * routes/people.access.test.ts). The pre-T3 shared shape was:
 *
 *     $transaction: async (fn) => fn(self)
 *
 * which silently DISCARDS the options argument, never rolls back, and runs
 * every transaction strictly serially. Three structural blind spots follow,
 * and every one of them shipped CI-green during epic WARP-1522:
 *
 *   1. isolation is unobservable — a route may claim `RepeatableRead` or
 *      `Serializable`, or claim nothing at all, and no test can tell. A
 *      READ COMMITTED transaction is invisible to Postgres SSI, so a bare
 *      `$transaction(fn)` does not merely race its own siblings, it defeats
 *      the isolation of the already-correct paths it races.
 *   2. atomicity is unobservable — a throw inside the callback leaves the
 *      partial writes in place, so "the refusal rolled everything back" is
 *      not a provable claim.
 *   3. concurrency is unreachable — two overlapping transactions cannot be
 *      expressed at all, so read-write skew (read the invariant, then write
 *      against it) has no failing test to write.
 *
 * These self-tests pin all three, plus the multi-tick reconciler seam, so
 * the harness itself cannot regress into the shape it replaced.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createTransactionSeam,
  createReconcilerSeam,
  P2034_WRITE_CONFLICT,
  expectAllTransactionsAt,
  gate,
} from "./helpers/prisma-tx-harness.js";

const SERIALIZABLE = { isolationLevel: "Serializable" } as const;

/** A miniature in-memory stub in the shape every route suite hand-rolls. */
function makeStub(seed: Array<[string, { role: string }]> = []) {
  const users = new Map<string, { role: string }>(
    seed.map(([k, v]) => [k, { ...v }]),
  );
  const self: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = users.get(id);
        return row ? { id, ...row } : null;
      }),
      count: vi.fn(async ({ where }: { where?: { role?: string } } = {}) =>
        [...users.values()].filter((u) => !where?.role || u.role === where.role)
          .length,
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = users.get(id);
          if (!row) throw new Error(`no such user ${id}`);
          Object.assign(row, data);
          return { id, ...row };
        },
      ),
    },
  };
  const seam = createTransactionSeam({
    client: () => self,
    stores: { users },
  });
  self.$transaction = seam.$transaction;
  return { self, users, seam };
}

// ── 1. isolation options are recorded, not discarded ───────────────

describe("WARP-1570 seam — the options argument survives", () => {
  it("records the options argument of every call, in call order", async () => {
    const { self, seam } = makeStub();
    await (self.$transaction as (fn: unknown, o?: unknown) => Promise<unknown>)(
      async () => "a",
      SERIALIZABLE,
    );
    await (self.$transaction as (fn: unknown, o?: unknown) => Promise<unknown>)(
      async () => "b",
    );
    expect(seam.calls()).toEqual([SERIALIZABLE, undefined]);
  });

  it("expectAllTransactionsAt fails loudly on a bare (READ COMMITTED) call", async () => {
    const { self, seam } = makeStub();
    await (self.$transaction as (fn: unknown, o?: unknown) => Promise<unknown>)(
      async () => "a",
      SERIALIZABLE,
    );
    await (self.$transaction as (fn: unknown, o?: unknown) => Promise<unknown>)(
      async () => "b",
    );
    // The old stub could not distinguish these two calls at all.
    expect(() => expectAllTransactionsAt(seam, SERIALIZABLE)).toThrow();
  });

  it("expectAllTransactionsAt fails when NO transaction was opened at all", () => {
    // Guards the vacuous pass: a route that stopped using a transaction
    // entirely must not satisfy an "all transactions are serializable"
    // assertion by having none.
    const { seam } = makeStub();
    expect(() => expectAllTransactionsAt(seam, SERIALIZABLE)).toThrow();
  });

  it("passes when every call carries the expected options", async () => {
    const { self, seam } = makeStub();
    const tx = self.$transaction as (fn: unknown, o?: unknown) => Promise<unknown>;
    await tx(async () => "a", SERIALIZABLE);
    await tx(async () => "b", SERIALIZABLE);
    expect(() => expectAllTransactionsAt(seam, SERIALIZABLE)).not.toThrow();
  });
});

// ── 2. atomicity: a throw inside the callback rolls back ───────────

describe("WARP-1570 seam — rollback", () => {
  it("restores every registered store when the callback throws", async () => {
    const { self, users } = makeStub([["u1", { role: "admin" }]]);
    const tx = self.$transaction as (
      fn: (tx: unknown) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;

    await expect(
      tx(async (t) => {
        await (t as typeof self & { user: { update: Function } }).user.update({
          where: { id: "u1" },
          data: { role: "guest" },
        });
        throw new Error("refused");
      }, SERIALIZABLE),
    ).rejects.toThrow("refused");

    // Without rollback the partial demote survives the refusal — the exact
    // shape that made "the guard refused, so nothing changed" unprovable.
    expect(users.get("u1")).toEqual({ role: "admin" });
  });

  it("keeps writes when the callback resolves", async () => {
    const { self, users } = makeStub([["u1", { role: "admin" }]]);
    const tx = self.$transaction as (
      fn: (tx: unknown) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;
    await tx(async (t) => {
      await (t as typeof self & { user: { update: Function } }).user.update({
        where: { id: "u1" },
        data: { role: "guest" },
      });
    }, SERIALIZABLE);
    expect(users.get("u1")).toEqual({ role: "guest" });
  });

  it("rolls back nested arrays and Maps by value, not by reference", async () => {
    const rows: Array<{ id: string; tags: string[] }> = [
      { id: "a", tags: ["x"] },
    ];
    const self: Record<string, unknown> = {};
    const seam = createTransactionSeam({ client: () => self, stores: { rows } });
    self.$transaction = seam.$transaction;
    const tx = self.$transaction as (
      fn: (tx: unknown) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;

    await expect(
      tx(async () => {
        rows[0].tags.push("y");
        rows.push({ id: "b", tags: [] });
        throw new Error("nope");
      }, SERIALIZABLE),
    ).rejects.toThrow("nope");

    expect(rows).toEqual([{ id: "a", tags: ["x"] }]);
  });
});

// ── 3. concurrency: two overlapping transactions ───────────────────

describe("WARP-1570 seam — concurrent transactions (read-write skew)", () => {
  /**
   * The canonical last-operator write skew: two admins demote themselves at
   * the same time. Each reads "2 operators remain, safe to demote", each
   * writes its own row, and the household lands on ZERO operators. This is
   * unreachable with a serial stub — the second transaction always sees the
   * first one's commit.
   */
  async function raceTwoDemotions(isolation: unknown) {
    const { self, users } = makeStub([
      ["a1", { role: "admin" }],
      ["a2", { role: "admin" }],
    ]);
    const tx = self.$transaction as (
      fn: (tx: any) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;

    const bothRead = gate();
    const demote = (id: string) =>
      tx(async (t: any) => {
        const operators = await t.user.count({ where: { role: "admin" } });
        await bothRead.arriveAndWait(); // hold both txs open past their read
        if (operators <= 1) throw new Error("LAST_OPERATOR_INVARIANT");
        await t.user.update({ where: { id }, data: { role: "guest" } });
      }, isolation);

    const results = await Promise.allSettled([demote("a1"), demote("a2")]);
    const remaining = [...users.values()].filter(
      (u) => u.role === "admin",
    ).length;
    return { results, remaining };
  }

  it("READ COMMITTED (bare call): both demotions commit — zero operators left", async () => {
    const { results, remaining } = await raceTwoDemotions(undefined);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(remaining).toBe(0); // the anomaly is now REACHABLE in a test
  });

  it("SERIALIZABLE: the loser aborts with P2034 and one operator survives", async () => {
    const { results, remaining } = await raceTwoDemotions(SERIALIZABLE);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: P2034_WRITE_CONFLICT,
    });
    expect(remaining).toBe(1);
  });

  it("a serializable abort rolls its own writes back", async () => {
    const { remaining } = await raceTwoDemotions(SERIALIZABLE);
    // 2 admins, one demoted, one aborted-and-rolled-back.
    expect(remaining).toBe(1);
  });

  it("a transaction opened while another is MID-CALLBACK is a sibling, not a nested join", async () => {
    // Regression: tracking "am I inside a transaction?" with a shared depth
    // counter conflates overlap with nesting. The second $transaction saw
    // depth > 0, joined the first as a nested call, and so never got its own
    // record — no snapshot, no conflict check, no rollback. Every concurrency
    // test would then pass vacuously. Nesting must be decided per async
    // context, not by a global counter.
    const { self, seam } = makeStub([
      ["a1", { role: "admin" }],
      ["a2", { role: "admin" }],
    ]);
    const tx = self.$transaction as (
      fn: (tx: any) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;

    // Party of 2 with only ONE arrival parks the first transaction until we
    // release it by hand — a held-open transaction, not a rendezvous.
    const firstMayFinish = gate(2);

    const first = tx(async (t: any) => {
      await t.user.count({ where: { role: "admin" } });
      await firstMayFinish.arriveAndWait();
      await t.user.update({ where: { id: "a1" }, data: { role: "guest" } });
    }, SERIALIZABLE);

    // Yield until the first transaction is genuinely mid-callback.
    await new Promise((r) => setTimeout(r, 0));
    expect(firstMayFinish.arrived()).toBe(1);

    // Opens, runs and COMMITS entirely inside the first one's lifetime.
    await tx(async (t: any) => {
      await t.user.count({ where: { role: "admin" } });
      await t.user.update({ where: { id: "a2" }, data: { role: "guest" } });
    }, SERIALIZABLE);

    firstMayFinish.release();
    const outcome = await Promise.allSettled([first]);

    // Two top-level calls ⇒ two recorded options entries either way; the
    // real tell is that the second one is a transaction of its own, so the
    // first must now lose the conflict race.
    expect(seam.calls()).toEqual([SERIALIZABLE, SERIALIZABLE]);
    expect(outcome[0].status).toBe("rejected");
    expect((outcome[0] as PromiseRejectedResult).reason).toMatchObject({
      code: P2034_WRITE_CONFLICT,
    });
    expect(seam.conflicts()).toBe(1);
  });

  it("rolling back around a concurrent commit preserves the WINNER's generated ids", async () => {
    // The loser's rollback must not disturb the winner. Naive rollback
    // (restore-then-replay) re-runs the winner's `create` against a stub
    // that mints ids, so the row comes back under a DIFFERENT id — and the
    // winning request, which captured the id inside its transaction, then
    // 404s on its own freshly-created row and 500s. The id the write
    // actually produced has to be pinned into the replay.
    const rows = new Map<string, { id: string; slug: string }>();
    let nextId = 1;
    const self: Record<string, unknown> = {
      role: {
        findMany: vi.fn(async () => [...rows.values()]),
        create: vi.fn(async ({ data }: { data: { id?: string; slug: string } }) => {
          const id = data.id ?? `role-${nextId++}`;
          const row = { ...data, id };
          rows.set(id, row);
          return row;
        }),
      },
    };
    const seam = createTransactionSeam({ client: () => self, stores: { rows } });
    self.$transaction = seam.$transaction;
    const tx = self.$transaction as (
      fn: (tx: any) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;

    const bothRead = gate(2);
    const create = (slug: string) =>
      tx(async (t: any) => {
        await t.role.findMany({ where: { slug: { startsWith: "r" } } });
        await bothRead.arriveAndWait();
        const created = await t.role.create({ data: { slug } });
        return created.id as string;
      }, SERIALIZABLE);

    const settled = await Promise.allSettled([create("a"), create("b")]);
    const winner = settled.find((s) => s.status === "fulfilled");
    expect(winner).toBeDefined();
    expect(seam.conflicts()).toBe(1);

    const winnerId = (winner as PromiseFulfilledResult<string>).value;
    expect([...rows.keys()]).toEqual([winnerId]);
    expect(rows.get(winnerId)).toBeDefined();
  });

  it("non-overlapping serializable transactions never conflict", async () => {
    const { self, users } = makeStub([
      ["a1", { role: "admin" }],
      ["a2", { role: "admin" }],
    ]);
    const tx = self.$transaction as (
      fn: (tx: any) => Promise<unknown>,
      o?: unknown,
    ) => Promise<unknown>;
    const demote = (id: string) =>
      tx(async (t: any) => {
        await t.user.count({ where: { role: "admin" } });
        await t.user.update({ where: { id }, data: { role: "guest" } });
      }, SERIALIZABLE);
    await demote("a1"); // fully committed before the next one opens
    await demote("a2");
    expect([...users.values()].every((u) => u.role === "guest")).toBe(true);
  });
});

// ── 4. multi-tick reconciler seam ──────────────────────────────────

describe("WARP-1570 seam — multi-tick reconciler", () => {
  it("records kicks without running them (routes must not block on convergence)", async () => {
    const tick = vi.fn(async () => ({ converged: 1 }));
    const seam = createReconcilerSeam(tick);
    seam.kickReconcile();
    seam.kickReconcile();
    expect(seam.kicks()).toBe(2);
    expect(tick).not.toHaveBeenCalled();
  });

  it("runTicks(n) drives the real tick n times against live state", async () => {
    // A convergence that needs TWO ticks: the first flips pending → active,
    // only then can the second attach the member. A single-tick harness
    // reports the first tick's zeros and calls it converged.
    const state = { dept: "pending", member: "queued" };
    const tick = vi.fn(async () => {
      if (state.dept === "pending") {
        state.dept = "active";
        return { attached: 0 };
      }
      if (state.member === "queued") {
        state.member = "attached";
        return { attached: 1 };
      }
      return { attached: 0 };
    });
    const seam = createReconcilerSeam(tick);
    seam.kickReconcile();

    const first = await seam.runTicks(1);
    expect(first).toEqual([{ attached: 0 }]);
    expect(state).toEqual({ dept: "active", member: "queued" });

    const second = await seam.runTicks(1);
    expect(second).toEqual([{ attached: 1 }]);
    expect(state).toEqual({ dept: "active", member: "attached" });
  });

  it("drainKicks() runs exactly one tick per recorded kick, then clears", async () => {
    const tick = vi.fn(async () => null);
    const seam = createReconcilerSeam(tick);
    seam.kickReconcile();
    seam.kickReconcile();
    await seam.drainKicks();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(seam.kicks()).toBe(0);
  });

  it("runToConvergence stops when a tick reports no change, and caps runaway ticks", async () => {
    let n = 0;
    const tick = vi.fn(async () => ({ changed: n++ < 2 ? 1 : 0 }));
    const seam = createReconcilerSeam(tick);
    const ticks = await seam.runToConvergence({
      settled: (r) => (r as { changed: number }).changed === 0,
      maxTicks: 10,
    });
    expect(ticks).toHaveLength(3); // two changing ticks + one settled tick

    const never = createReconcilerSeam(async () => ({ changed: 1 }));
    await expect(
      never.runToConvergence({
        settled: (r) => (r as { changed: number }).changed === 0,
        maxTicks: 3,
      }),
    ).rejects.toThrow(/did not converge/i);
  });
});

// ── 5. the gate primitive itself ───────────────────────────────────

describe("WARP-1570 seam — gate()", () => {
  it("releases both waiters only once both have arrived", async () => {
    const g = gate(2);
    const order: string[] = [];
    const a = (async () => {
      order.push("a-arrive");
      await g.arriveAndWait();
      order.push("a-resume");
    })();
    const b = (async () => {
      order.push("b-arrive");
      await g.arriveAndWait();
      order.push("b-resume");
    })();
    await Promise.all([a, b]);
    expect(order.slice(0, 2).sort()).toEqual(["a-arrive", "b-arrive"]);
    expect(order.slice(2).sort()).toEqual(["a-resume", "b-resume"]);
  });

  it("does not deadlock a single participant when the party size is 1", async () => {
    const g = gate(1);
    await expect(g.arriveAndWait()).resolves.toBeUndefined();
  });
});
