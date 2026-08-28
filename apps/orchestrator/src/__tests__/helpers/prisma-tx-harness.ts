/**
 * WARP-1570 — the shared route-test Prisma transaction seam.
 *
 * ## Why this module exists
 *
 * Every route suite in this app hand-rolls an in-memory Prisma stub. Until
 * now they all shared one line:
 *
 *     $transaction: async (fn) => fn(self)
 *
 * That line is the single most expensive test-harness defect in the
 * codebase. It silently DISCARDS the options argument, so a route can claim
 * `{ isolationLevel: "Serializable" }` — or claim nothing at all — and no
 * test can tell the difference. It never rolls back, so "the guard refused,
 * therefore nothing was written" is unprovable. And it runs every
 * transaction to completion before the next one starts, so read-write skew
 * between two concurrent requests cannot be expressed at all.
 *
 * Five separate defect classes shipped CI-green through that gap during
 * epic WARP-1522. The RBAC v2 T3 branch fixed it locally, inside two suites
 * (routes/access.routes.test.ts, routes/people.access.test.ts). This module
 * is that fix promoted to a shared seam plus the two capabilities T3 did
 * not need but the reconciler and concurrency defect classes do: genuinely
 * overlapping transactions with a Postgres-shaped conflict rule, and a
 * multi-tick reconciler driver.
 *
 * ## What it models, and what it does not
 *
 * MODELLED — deliberately, because each maps to a shipped defect:
 *
 *   - the options argument, recorded per call (`calls()`).
 *   - atomicity: a throw inside the callback undoes that transaction's
 *     writes, including when another transaction committed in the meantime.
 *   - overlap: two `$transaction` calls may be in flight at once; use
 *     `gate()` to pin the interleaving deterministically.
 *   - a Postgres-shaped conflict rule at commit time:
 *       * `Serializable`  → read-write dependency. If a transaction that
 *         committed while we were open wrote anything we READ, we abort
 *         with P2034. This is SSI's dangerous-structure rule, simplified in
 *         the conservative direction (like real SSI, it can false-positive;
 *         unlike real SSI, it will not catch every anomaly).
 *       * `RepeatableRead` → write-write conflict only. Postgres does not
 *         detect read-write skew at this level, and neither do we.
 *       * absent / `ReadCommitted` → no check. The anomaly commits, which
 *         is the entire point: a test can now PROVE that dropping the
 *         isolation option reintroduces the bug, instead of asserting an
 *         options object and hoping.
 *
 * NOT MODELLED — do not read more into a green test than this:
 *
 *   - predicate locks, phantom rows, or index-range granularity. Read and
 *     write keys are `model:id` for a keyed `where`, `model:*` otherwise.
 *   - lock waits / deadlock detection. Conflicts are decided at commit.
 *   - more than two overlapping transactions. Rollback replays the writes of
 *     transactions that COMMITTED in the interim; a third transaction still
 *     open with uncommitted writes would lose them. Two-way races (the shape
 *     every RBAC v2 defect took) are exact; three-way is not.
 *   - `createMany` ids across a rollback. Single-row `create`/`upsert` pin
 *     the generated id into the replay, so the winner's row survives a
 *     concurrent rollback intact; `createMany` returns only a count, so a
 *     suite that needs stable ids there should seed them explicitly.
 *
 * A real Postgres remains the only proof for the above: that is what the
 * `*.pg.test.ts` lane (RUN_PG_INTEGRATION=1) is for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { vi, type Mock } from "vitest";

/** Prisma's write-conflict / deadlock code, thrown by SSI aborts. */
export const P2034_WRITE_CONFLICT = "P2034";

type AnyRecord = Record<string, unknown>;

/**
 * A store the seam snapshots for rollback. Either the live container
 * (mutated in place) or an accessor pair for suites that REASSIGN the
 * binding (`rows = rows.filter(...)`), which a plain reference cannot see.
 */
export type Store =
  | Map<unknown, unknown>
  | unknown[]
  | { get(): unknown; set(next: unknown): void };

export interface TransactionSeamOptions {
  /** The object handed to the callback as `tx` — usually the stub itself. */
  client: () => unknown;
  /** Stores to snapshot so a throwing callback rolls back. */
  stores?: Record<string, Store>;
  /** Escape hatch for state `stores` cannot express. */
  snapshot?: () => unknown;
  restore?: (snap: unknown) => void;
  /** Runs on entry, before the callback. Handy as a manual barrier. */
  onEnter?: (ctx: { options: unknown; index: number }) => void | Promise<void>;
}

/**
 * The seam's `$transaction`, typed as the vitest mock it is so suites keep
 * `mock.calls`, `mockImplementationOnce`, and friends.
 */
export type TransactionMock = Mock<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn: (tx: any) => Promise<unknown>, options?: unknown) => Promise<unknown>
>;

export interface TransactionSeam {
  /** Drop-in replacement for `PrismaClient.$transaction`. */
  $transaction: TransactionMock;
  /** The options argument of every top-level call, in call order. */
  calls(): readonly unknown[];
  /** How many transactions aborted with P2034. */
  conflicts(): number;
  reset(): void;
}

const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

const READ_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** `model:id` for a keyed where-clause, `model:*` for anything broader. */
function keyFor(model: string, args: unknown): string {
  const where = (args as { where?: AnyRecord } | undefined)?.where;
  const id = where?.id;
  if (typeof id === "string" || typeof id === "number") return `${model}:${id}`;
  return `${model}:*`;
}

/** Does a read key collide with a write key? `*` is the whole model. */
function collides(readKey: string, writeKey: string): boolean {
  if (readKey === writeKey) return true;
  const [rModel, rId] = readKey.split(":");
  const [wModel, wId] = writeKey.split(":");
  if (rModel !== wModel) return false;
  return rId === "*" || wId === "*";
}

function cloneStore(store: Store): unknown {
  if (store instanceof Map) return structuredClone([...store.entries()]);
  if (Array.isArray(store)) return structuredClone(store);
  return structuredClone(store.get());
}

function restoreStore(store: Store, snap: unknown): void {
  if (store instanceof Map) {
    store.clear();
    for (const [k, v] of snap as Array<[unknown, unknown]>) store.set(k, v);
    return;
  }
  if (Array.isArray(store)) {
    store.length = 0;
    store.push(...(snap as unknown[]));
    return;
  }
  store.set(snap);
}

/**
 * For INSERTing methods only, fold the id the stub generated back into the
 * call's `data` so a replay reproduces the same row rather than a new one.
 * Never applied to `update`/`delete` — their result carries an id too, but
 * writing it into `data` would be an id rewrite.
 */
function pinGeneratedId(
  method: string,
  args: unknown,
  result: unknown,
): unknown {
  if (method !== "create" && method !== "upsert") return args;
  const call = args as { data?: Record<string, unknown> } | undefined;
  const data = call?.data;
  if (!data || Array.isArray(data) || data.id !== undefined) return args;
  const id = (result as { id?: unknown } | null | undefined)?.id;
  if (id === undefined || id === null) return args;
  return { ...call, data: { ...data, id } };
}

interface TxRecord {
  openedAt: number;
  committedAt: number | null;
  isolation: string | undefined;
  reads: Set<string>;
  writes: Set<string>;
  /** Replayable write calls, for reconstructing state around a rollback. */
  writeLog: Array<{ model: string; method: string; args: unknown }>;
}

/**
 * Build the `$transaction` seam for an in-memory Prisma stub.
 *
 * ```ts
 * const seam = createTransactionSeam({ client: () => self, stores: { users } });
 * self.$transaction = seam.$transaction;
 * // ...drive the route, then:
 * expectAllTransactionsAt(seam, SERIALIZABLE_TX);
 * ```
 */
export function createTransactionSeam(
  opts: TransactionSeamOptions,
): TransactionSeam {
  const stores = opts.stores ?? {};
  let optionsLog: unknown[] = [];
  let conflictCount = 0;
  let clock = 0;
  let live: TxRecord[] = [];
  /**
   * "Am I already inside a transaction?" is a PER-ASYNC-CONTEXT question,
   * never a global one. A shared depth counter conflates overlap with
   * nesting: the moment two requests are in flight, the second
   * `$transaction` sees depth > 0, joins the first as a nested call, and
   * silently loses its own snapshot, conflict check, and rollback — so
   * every concurrency test passes vacuously. AsyncLocalStorage is the only
   * thing that answers the question correctly.
   */
  const activeTx = new AsyncLocalStorage<TxRecord>();

  function snapshotAll() {
    const snap: Record<string, unknown> = {};
    for (const [name, store] of Object.entries(stores)) {
      snap[name] = cloneStore(store);
    }
    return { stores: snap, extra: opts.snapshot?.() };
  }

  function restoreAll(snap: ReturnType<typeof snapshotAll>) {
    for (const [name, store] of Object.entries(stores)) {
      restoreStore(store, snap.stores[name]);
    }
    if (opts.restore) opts.restore(snap.extra);
  }

  /** Wrap the client so model-method calls land in the current read/write set. */
  function track(client: unknown, rec: TxRecord): unknown {
    return new Proxy(client as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string") return value;
        if (prop.startsWith("$") || prop.startsWith("_")) return value;
        if (typeof value !== "object" || value === null) return value;
        const model = prop;
        return new Proxy(value as object, {
          get(mTarget, mProp, mReceiver) {
            const method = Reflect.get(mTarget, mProp, mReceiver);
            if (typeof mProp !== "string" || typeof method !== "function") {
              return method;
            }
            const isWrite = WRITE_METHODS.has(mProp);
            const isRead = READ_METHODS.has(mProp);
            if (!isWrite && !isRead) return method;
            return async (...args: unknown[]) => {
              const key = keyFor(model, args[0]);
              const call = (method as (...a: unknown[]) => unknown).apply(
                mTarget,
                args,
              );
              if (isRead) {
                rec.reads.add(key);
                return call;
              }
              rec.writes.add(key);
              const result = await call;
              // Pin a stub-GENERATED id into the replayable call. Rolling
              // another transaction back re-runs this write; without the id
              // the stub mints a fresh one, the row comes back under a
              // different id, and the request that captured it inside its own
              // (committed) transaction then 404s on its own row.
              rec.writeLog.push({
                model,
                method: mProp,
                args: pinGeneratedId(mProp, args[0], result),
              });
              return result;
            };
          },
        });
      },
    });
  }

  /**
   * Conflicts with transactions that committed while we were open.
   * Serializable = read-write dependency; RepeatableRead = write-write.
   */
  function conflictsWith(rec: TxRecord): boolean {
    const level = rec.isolation;
    if (level !== "Serializable" && level !== "RepeatableRead") return false;
    const mine = level === "Serializable" ? rec.reads : rec.writes;
    for (const other of live) {
      if (other === rec) continue;
      if (other.committedAt === null) continue;
      if (other.committedAt <= rec.openedAt) continue; // committed before we opened
      for (const w of other.writes) {
        for (const r of mine) if (collides(r, w)) return true;
      }
    }
    return false;
  }

  /** Re-apply the writes of every transaction that committed after `since`. */
  async function replayCommittedAfter(since: number, exclude: TxRecord) {
    const client = opts.client() as AnyRecord;
    const pending = live
      .filter(
        (t) =>
          t !== exclude && t.committedAt !== null && t.committedAt > since,
      )
      .sort((a, b) => (a.committedAt ?? 0) - (b.committedAt ?? 0));
    for (const t of pending) {
      for (const w of t.writeLog) {
        const model = client[w.model] as AnyRecord | undefined;
        const fn = model?.[w.method];
        if (typeof fn === "function") {
          await (fn as (a: unknown) => unknown).call(model, w.args);
        }
      }
    }
  }

  const $transaction: TransactionMock = vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (fn: (tx: any) => Promise<unknown>, options?: unknown) => {
      // Prisma's array form (`$transaction([p1, p2])`) is a batch, not an
      // interactive transaction — settle it and return the results.
      if (Array.isArray(fn)) {
        optionsLog.push(options);
        return Promise.all(fn as unknown[]);
      }

      // A nested call joins its parent: one snapshot, one conflict entry.
      const parent = activeTx.getStore();
      if (parent) {
        optionsLog.push(options);
        return fn(track(opts.client(), parent));
      }

      optionsLog.push(options);
      const rec: TxRecord = {
        openedAt: ++clock,
        committedAt: null,
        isolation: (options as { isolationLevel?: string } | undefined)
          ?.isolationLevel,
        reads: new Set(),
        writes: new Set(),
        writeLog: [],
      };
      live.push(rec);
      const snap = snapshotAll();

      await opts.onEnter?.({ options, index: optionsLog.length - 1 });

      let result: unknown;
      try {
        result = await activeTx.run(rec, () => fn(track(opts.client(), rec)));
      } catch (err) {
        restoreAll(snap);
        await replayCommittedAfter(rec.openedAt, rec);
        throw err;
      }

      if (conflictsWith(rec)) {
        conflictCount += 1;
        restoreAll(snap);
        await replayCommittedAfter(rec.openedAt, rec);
        const err = new Error(
          "Transaction failed due to a write conflict or a deadlock. " +
            "Please retry your transaction (WARP-1570 seam: simulated SSI abort)",
        ) as Error & { code: string };
        err.code = P2034_WRITE_CONFLICT;
        throw err;
      }

      rec.committedAt = ++clock;
      return result;
    },
  );

  return {
    $transaction,
    calls: () => optionsLog,
    conflicts: () => conflictCount,
    reset() {
      optionsLog = [];
      conflictCount = 0;
      clock = 0;
      live = [];
      $transaction.mockClear();
    },
  };
}

/**
 * Assert that the request under test opened at least one transaction and
 * that EVERY one of them carried `expected`.
 *
 * Fails on zero transactions on purpose: a route that stopped opening one
 * must not satisfy "all transactions are serializable" vacuously.
 */
export function expectAllTransactionsAt(
  seam: Pick<TransactionSeam, "calls">,
  expected: unknown,
): void {
  const calls = seam.calls();
  if (calls.length === 0) {
    throw new Error(
      "expectAllTransactionsAt: no transaction was opened. Either the route " +
        "stopped using $transaction, or the stub's $transaction is not the " +
        "seam's (WARP-1570).",
    );
  }
  const expectedJson = JSON.stringify(expected);
  calls.forEach((actual, i) => {
    if (JSON.stringify(actual) !== expectedJson) {
      throw new Error(
        `expectAllTransactionsAt: transaction #${i} opened at ` +
          `${JSON.stringify(actual)}, expected ${expectedJson}. A transaction ` +
          "without an explicit isolationLevel runs at READ COMMITTED, which " +
          "is invisible to Postgres SSI — it defeats the isolation of every " +
          "serializable path it races (WARP-1570).",
      );
    }
  });
}

// ── concurrency primitive ──────────────────────────────────────────

export interface Gate {
  /** Block until `party` participants have arrived, then release all. */
  arriveAndWait(): Promise<void>;
  /** Release every current waiter regardless of the party size. */
  release(): void;
  arrived(): number;
}

/**
 * A one-shot rendezvous barrier. Park two in-flight transactions at the
 * same point so their interleaving is deterministic instead of a race the
 * event loop happens to order.
 */
export function gate(party = 2): Gate {
  let count = 0;
  const waiters: Array<() => void> = [];
  const releaseAll = () => {
    const pending = waiters.splice(0, waiters.length);
    for (const w of pending) w();
  };
  return {
    arrived: () => count,
    release: releaseAll,
    arriveAndWait() {
      count += 1;
      if (count >= party) {
        releaseAll();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

// ── multi-tick reconciler seam ─────────────────────────────────────

export interface ReconcilerSeam<R> {
  /** Stand-in for `kickReconcile()` — records, never runs. */
  kickReconcile: () => void;
  kicks(): number;
  /** Run the real tick `n` times against live state. */
  runTicks(n?: number): Promise<R[]>;
  /** Run exactly one tick per recorded kick, then clear the counter. */
  drainKicks(): Promise<R[]>;
  /** Tick until `settled` reports convergence, or throw past `maxTicks`. */
  runToConvergence(opts: {
    settled: (result: R) => boolean;
    maxTicks?: number;
  }): Promise<R[]>;
  reset(): void;
}

/**
 * Make multi-tick convergence reachable from a route suite.
 *
 * Route suites mock `kickReconcile` to a bare `vi.fn()`, so everything the
 * reconciler does AFTER the response is invisible: the second-tick
 * behaviours (pending → active → attach; intent-preserving archive/removal
 * retries; the stuck-failed alert) have no route-level test that can reach
 * them. Wire this seam instead and the suite can drive real ticks against
 * the same in-memory stub the route just wrote to.
 *
 * ```ts
 * const reconciler = createReconcilerSeam(() => reconcileDepartments(prisma));
 * vi.mock("../services/department-reconciler.service.js", () => ({
 *   kickReconcile: reconciler.kickReconcile,
 * }));
 * // ...drive the route...
 * expect(reconciler.kicks()).toBe(1);
 * await reconciler.runTicks(2); // the convergence the route only scheduled
 * ```
 */
export function createReconcilerSeam<R>(
  tick: () => Promise<R>,
): ReconcilerSeam<R> {
  let kicks = 0;
  return {
    kickReconcile: () => {
      kicks += 1;
    },
    kicks: () => kicks,
    async runTicks(n = 1) {
      const out: R[] = [];
      for (let i = 0; i < n; i += 1) out.push(await tick());
      return out;
    },
    async drainKicks() {
      const n = kicks;
      kicks = 0;
      const out: R[] = [];
      for (let i = 0; i < n; i += 1) out.push(await tick());
      return out;
    },
    async runToConvergence({ settled, maxTicks = 8 }) {
      const out: R[] = [];
      for (let i = 0; i < maxTicks; i += 1) {
        const result = await tick();
        out.push(result);
        if (settled(result)) return out;
      }
      throw new Error(
        `runToConvergence: did not converge within ${maxTicks} ticks. A ` +
          "reconciler that never settles is an infinite-work bug, not a slow " +
          "one — it re-pushes the same drift on every tick, forever " +
          "(WARP-1570).",
      );
    },
    reset() {
      kicks = 0;
    },
  };
}
