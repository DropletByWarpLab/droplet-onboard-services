/**
 * WARP-1583 — the effective-access resolver's READ-CONSISTENCY contract.
 *
 * `effective-access.service.ts` composes ONE authorization answer out of a
 * `user.findUnique` (with nested relation selects) plus a six-way
 * `Promise.all`. None of that was enclosed in a transaction, so each
 * statement took its OWN READ COMMITTED snapshot and the composed answer
 * could pair rows that never coexisted in the database.
 *
 * The T3 review logged this as C1 and accepted it for v1 on the grounds that
 * `clampLevel` re-clamps every FEATURE grant against the tier at compose
 * time, so a tear can only under-permit. The service header is careful to
 * say that guarantee does NOT extend to the CONNECTOR axis, which has no
 * compose-time floor at all — and that is the tear this suite pins.
 *
 * ## Why these tests, and not an options assertion
 *
 * `expect($transaction).toHaveBeenCalledWith(expect.anything(), REPEATABLE_
 * READ_TX)` proves that a constant was passed. It does not prove the reads
 * moved into one snapshot, and it stays green if `getEffectiveModuleIds`
 * keeps reading through the top-level client from inside the transaction —
 * which is the exact trap the ticket calls out, because threading `tx` there
 * changes a `modules.service` signature shared with the module gate. Five
 * defect classes shipped CI-green through assertions of that shape during
 * epic WARP-1522 (WARP-1570). So the tests below assert on the RESOLVED
 * ANSWER while a real mutation commits mid-resolve.
 *
 * ## What the stub models
 *
 * Two things beyond the shared seam (`__tests__/helpers/prisma-tx-harness`),
 * both of which are properties of the real stack, not of this test:
 *
 *   1. SNAPSHOT READS BOUND TO THE CLIENT OBJECT. A transaction's handle
 *      answers reads from the state captured when it opened; the top-level
 *      client always answers from live state. That is what RepeatableRead
 *      buys, and binding it to the handle (rather than to the async context)
 *      is deliberate: it is what makes an un-threaded
 *      `getEffectiveModuleIds(prisma, cfg)` call FAIL these tests instead of
 *      riding along on the caller's snapshot.
 *
 *   2. PRISMA'S STATEMENT EMISSION. Prisma's default relation-load strategy
 *      is `query`: a `findUnique` with nested `select`s is emitted as the
 *      scalar row query plus one query per relation, stitched in memory —
 *      not one join. So `user.role` and `accessRole.connectorGrants` are
 *      separate statements with separate snapshots, which is precisely the
 *      "new User.role with the old featureGrants" the ticket describes.
 *
 * NOT modelled: predicate locks, lock waits, real MVCC visibility rules.
 * `*.pg.test.ts` (RUN_PG_INTEGRATION=1) remains the only proof of those.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  gate,
} from "../__tests__/helpers/prisma-tx-harness.js";
import { SERIALIZABLE_TX } from "./role-mutation-guard.service.js";
import { REPEATABLE_READ_TX } from "../lib/prisma-tx.js";
import {
  resolveEffectiveAccess,
  _setEffectiveAccessForTests,
} from "./effective-access.service.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

// ── the box config every test resolves against ─────────────────────
//
// Every availability predicate satisfied, so "is this module effective?"
// is decided purely by the ModuleSetting rows the tests write.
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai-gateway:8080",
  FILE_INDEXER_URL: "http://file-indexer:8000",
  NEXTCLOUD_URL: "http://nextcloud",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok-email",
  SERVICE_TOKEN_VOICE: "tok-voice",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8100",
  ROUTING_SERVICE_URL: "http://routing:8000",
  SWITCH_SERVICE_URL: "http://switch:8000",
};

// ── the slice of state the resolver reads ──────────────────────────

type FeatureLevel = "view" | "act" | "manage";
type ConnectorLevel = "read" | "read_write";

interface State {
  users: Array<{ id: string; role: string; accessRoleId: string | null }>;
  roles: Array<{
    id: string;
    mayOperateLocks: boolean;
    cloudModelsAllowed: boolean;
    storageQuotaBytes: bigint | null;
    maxUploadSizeMb: number | null;
    llmDailyMessageCap: number | null;
  }>;
  featureGrants: Array<{ roleId: string; moduleId: string; level: FeatureLevel }>;
  toolGrants: Array<{ roleId: string; domain: string; level: "view" | "use" }>;
  connectorGrants: Array<{ roleId: string; provider: string; level: ConnectorLevel }>;
  exceptions: Array<{
    id: string;
    userId: string;
    moduleId: string;
    effect: string;
    level: FeatureLevel | null;
  }>;
  moduleSettings: Array<{ moduleId: string; enabled: boolean }>;
  connections: Array<{ provider: string; writeEnabled: boolean }>;
  cloudEscape: boolean;
}

/**
 * Hooks the stub fires from INSIDE a read, so a concurrent transaction can
 * be commanded to commit at an exact statement boundary. Each corresponds to
 * a real boundary in `resolveEffectiveAccess`.
 */
interface Hooks {
  /** Between the scalar `user` row and its nested relation selects. */
  betweenUserRowAndRelations?: () => Promise<void>;
  /** Before `getEffectiveModuleIds` issues its `moduleSetting` read. */
  beforeModuleRead?: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The read half. `src()` decides WHICH state answers — live, or a snapshot. */
function readModels(src: () => State, hooks: Hooks): Record<string, Any> {
  return {
    user: {
      async findUnique({ where }: Any) {
        const found = src().users.find((u) => u.id === where.id);
        if (!found) return null;
        // MATERIALIZED, not aliased. A query returns a value; holding a live
        // reference here would let a concurrent write retroactively rewrite
        // a statement that already completed, which no database does — and
        // it would hide the very tear this suite exists to catch.
        const row = { ...found };
        // Statement boundary: Prisma has fetched the scalar row and is about
        // to fetch each relation as its own query.
        await hooks.betweenUserRowAndRelations?.();
        const s = src();
        const role = row.accessRoleId
          ? (s.roles.find((r) => r.id === row.accessRoleId) ?? null)
          : null;
        return {
          id: row.id,
          role: row.role,
          accessRole: role
            ? {
                mayOperateLocks: role.mayOperateLocks,
                cloudModelsAllowed: role.cloudModelsAllowed,
                storageQuotaBytes: role.storageQuotaBytes,
                maxUploadSizeMb: role.maxUploadSizeMb,
                llmDailyMessageCap: role.llmDailyMessageCap,
                featureGrants: s.featureGrants
                  .filter((g) => g.roleId === role.id)
                  .map(({ moduleId, level }) => ({ moduleId, level })),
                toolGrants: s.toolGrants
                  .filter((g) => g.roleId === role.id)
                  .map(({ domain, level }) => ({ domain, level })),
                connectorGrants: s.connectorGrants
                  .filter((g) => g.roleId === role.id)
                  .map(({ provider, level }) => ({ provider, level })),
              }
            : null,
        };
      },
    },
    userAccessException: {
      async findMany({ where }: Any) {
        return src().exceptions.filter((x) => x.userId === where.userId);
      },
    },
    moduleSetting: {
      async findMany() {
        await hooks.beforeModuleRead?.();
        return src().moduleSettings.map((m) => ({ ...m }));
      },
    },
    offLanAllowlistChannel: {
      async findUnique() {
        return { enabled: src().cloudEscape };
      },
    },
    integrationConnection: {
      async findMany() {
        return src().connections.map((c) => ({ ...c }));
      },
    },
    userUsagePolicy: {
      async findUnique() {
        return null;
      },
    },
    departmentMembership: {
      async findMany() {
        return [];
      },
    },
  };
}

/** The write half — always lands on live state, never on a snapshot. */
function writeModels(live: () => State): Record<string, Any> {
  return {
    user: {
      async update({ where, data }: Any) {
        const row = live().users.find((u) => u.id === where.id);
        if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(row, data);
        return { ...row };
      },
    },
    accessRoleConnectorGrant: {
      async deleteMany({ where }: Any) {
        const s = live();
        const before = s.connectorGrants.length;
        s.connectorGrants = s.connectorGrants.filter((g) => g.roleId !== where.roleId);
        return { count: before - s.connectorGrants.length };
      },
      async createMany({ data }: Any) {
        live().connectorGrants.push(...data);
        return { count: data.length };
      },
    },
    moduleSetting: {
      async upsert({ where, update, create }: Any) {
        const s = live();
        const row = s.moduleSettings.find((m) => m.moduleId === where.moduleId);
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        s.moduleSettings.push({ ...create });
        return { ...create };
      },
    },
  };
}

function mergeModels(...layers: Array<Record<string, Any>>): Record<string, Any> {
  const out: Record<string, Any> = {};
  for (const layer of layers) {
    for (const [model, methods] of Object.entries(layer)) {
      out[model] = { ...(out[model] ?? {}), ...methods };
    }
  }
  return out;
}

function seedState(overrides: Partial<State> = {}): State {
  return {
    users: [{ id: "u-1", role: "family", accessRoleId: "r-1" }],
    roles: [
      {
        id: "r-1",
        mayOperateLocks: false,
        cloudModelsAllowed: false,
        storageQuotaBytes: null,
        maxUploadSizeMb: null,
        llmDailyMessageCap: null,
      },
    ],
    featureGrants: [{ roleId: "r-1", moduleId: "cameras", level: "view" }],
    toolGrants: [{ roleId: "r-1", domain: "cameras", level: "view" }],
    connectorGrants: [{ roleId: "r-1", provider: "google", level: "read" }],
    exceptions: [],
    // Every non-core module explicitly ON, so the workspace intersection is
    // decided by these rows and not by a registry default drifting later.
    moduleSettings: [
      { moduleId: "cameras", enabled: true },
      { moduleId: "files", enabled: true },
      { moduleId: "knowledge", enabled: true },
    ],
    connections: [{ provider: "google", writeEnabled: true }],
    cloudEscape: false,
    ...overrides,
  };
}

function makeDb(seed: State, hooks: Hooks) {
  let live = seed;

  const self: Record<string, Any> = mergeModels(
    readModels(() => live, hooks),
    writeModels(() => live),
  );

  const seam = createTransactionSeam({
    client: () => self,
    stores: {
      live: {
        get: () => live,
        set: (next: unknown) => {
          live = next as State;
        },
      },
    },
  });

  const rawTransaction = seam.$transaction;

  /**
   * A transaction handle whose READS answer from the state captured at
   * open (RepeatableRead), while writes and `$`-methods pass straight
   * through to the seam's tracking proxy so rollback and the commit-time
   * conflict rule still apply.
   */
  function snapshotHandle(tracked: Any): Any {
    const snapshot = structuredClone(live);
    const reads = readModels(() => snapshot, hooks);
    return new Proxy(tracked, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !(prop in reads)) return value;
        const modelReads = reads[prop];
        return new Proxy(value ?? {}, {
          get(mTarget, mProp, mReceiver) {
            if (typeof mProp === "string" && mProp in modelReads) {
              return modelReads[mProp];
            }
            return Reflect.get(mTarget, mProp, mReceiver);
          },
        });
      },
    });
  }

  self.$transaction = (fn: Any, options?: unknown) =>
    Array.isArray(fn)
      ? rawTransaction(fn as Any, options)
      : rawTransaction((tracked: Any) => fn(snapshotHandle(tracked)), options);

  return {
    prisma: self,
    seam,
    state: () => live,
  };
}

/**
 * Park a mutation so it commits at an exact statement boundary of the
 * resolve under test. `letItCommit()` is called from a read hook; it hands
 * control to the mutation and does not return until that transaction has
 * committed.
 */
function concurrentCommit(prisma: Any, mutate: (tx: Any) => Promise<void>) {
  const open = gate(2);
  const done = gate(2);
  const promise = (async () => {
    await open.arriveAndWait();
    // The concurrent writer is a real guarded mutation: SERIALIZABLE, as
    // every /api/access write is opened (WARP-1526).
    await prisma.$transaction(mutate, SERIALIZABLE_TX);
    await done.arriveAndWait();
  })();
  return {
    async letItCommit() {
      await open.arriveAndWait();
      await done.arriveAndWait();
    },
    settled: () => promise,
  };
}

afterEach(() => {
  _setEffectiveAccessForTests(null, null);
});

describe("WARP-1583 — resolveEffectiveAccess composes ONE snapshot", () => {
  /**
   * The ticket's canonical tear, on the axis with no compose-time floor.
   *
   * The concurrent writer is `PATCH /api/access/roles/:id` re-basing a role
   * from `family` to `admin` — one SERIALIZABLE transaction that writes both
   * halves of the invariant: the members' `User.role`, and the role's
   * connector grants re-normalized by `normalizeGrants` (whose O-2 floor is
   * "read_write is selectable only on an Admin-based role").
   *
   * Read `User.role` before that commit and `connectorGrants` after it and
   * the resolver returns `tier: "family"` holding `read_write` — a pairing
   * neither committed state ever held, and one the O-2 floor exists to make
   * unrepresentable. `computeEffectiveAccess` applies no tier floor to the
   * connector axis (only `min(grant, connection.writeEnabled)`), so nothing
   * downstream re-clamps it: this tear WIDENS access, unlike the feature-axis
   * tear the T3 review measured.
   */
  it("never pairs a pre-change tier with post-change connector grants", async () => {
    const hooks: Hooks = {};
    const { prisma, state } = makeDb(seedState(), hooks);
    _setEffectiveAccessForTests(prisma as never, CFG);

    const rebase = concurrentCommit(prisma, async (tx) => {
      await tx.user.update({ where: { id: "u-1" }, data: { role: "admin" } });
      await tx.accessRoleConnectorGrant.deleteMany({ where: { roleId: "r-1" } });
      await tx.accessRoleConnectorGrant.createMany({
        data: [{ roleId: "r-1", provider: "google", level: "read_write" }],
      });
    });
    hooks.betweenUserRowAndRelations = rebase.letItCommit;

    const access = await resolveEffectiveAccess("u-1");
    await rebase.settled();

    // The mutation really did commit — the tear is a resolver bug, not a
    // mutation that never ran.
    expect(state().users[0].role).toBe("admin");
    expect(state().connectorGrants[0].level).toBe("read_write");

    // The whole point: the answer must equal ONE committed state. The
    // resolve opened before the re-base committed, so under RepeatableRead
    // that state is the pre-change one.
    expect(access).not.toBeNull();
    expect({
      tier: access!.tier,
      google: access!.connectors.google,
    }).toEqual({ tier: "family", google: "read" });
  });

  /**
   * The threading half of the fix, and the one an options assertion cannot
   * reach. `getEffectiveModuleIds(prisma, cfg)` reads `ModuleSetting`
   * through whichever client it is handed; wrapping the resolver in a
   * transaction while still passing the top-level client leaves that read on
   * its own snapshot, and the workspace intersection — which decides whether
   * a feature resolves at all — is composed from a different instant than
   * the grants it narrows.
   */
  it("reads workspace modules inside the same snapshot as the role grants", async () => {
    const hooks: Hooks = {};
    const { prisma, state } = makeDb(seedState(), hooks);
    _setEffectiveAccessForTests(prisma as never, CFG);

    // `setModuleEnabled` turning Cameras off box-wide, mid-resolve.
    const toggle = concurrentCommit(prisma, async (tx) => {
      await tx.moduleSetting.upsert({
        where: { moduleId: "cameras" },
        update: { enabled: false },
        create: { moduleId: "cameras", enabled: false },
      });
    });
    hooks.beforeModuleRead = toggle.letItCommit;

    const access = await resolveEffectiveAccess("u-1");
    await toggle.settled();

    expect(state().moduleSettings.find((m) => m.moduleId === "cameras")!.enabled).toBe(
      false,
    );

    // The grants were read from the pre-toggle snapshot, so the module set
    // must be too: `cameras` still resolves, exactly as it did at open.
    expect(access!.features.map((f) => f.moduleId)).toContain("cameras");
    expect(access!.toolDomains).toContain("cameras");
  });

  it("opens exactly one transaction, at RepeatableRead", async () => {
    const { prisma, seam } = makeDb(seedState(), {});
    _setEffectiveAccessForTests(prisma as never, CFG);

    await resolveEffectiveAccess("u-1");

    // RepeatableRead and NOT Serializable, deliberately. The resolver is
    // read-only, so it has no write-write conflict to lose — but Postgres
    // SSI can and does abort read-only transactions to preserve
    // serializability, which would turn a plain authorization read into a
    // P2034 and a 500 on every gated route. RepeatableRead buys the stable
    // snapshot this composition needs and cannot abort a read-only
    // transaction.
    expectAllTransactionsAt(seam, REPEATABLE_READ_TX);
    expect(seam.calls()).toHaveLength(1);
    expect(seam.conflicts()).toBe(0);
  });
});
