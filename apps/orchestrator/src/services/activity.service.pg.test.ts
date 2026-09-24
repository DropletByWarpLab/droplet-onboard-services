/**
 * WARP-1026 — real-Postgres concurrency tests for the activity recorder.
 *
 * The mocked-Prisma unit suite (activity.service.test.ts) structurally
 * cannot catch the chain fork: it is a READ COMMITTED visibility artifact
 * of `SELECT ... FOR UPDATE` under concurrent writers (EvalPlanQual
 * re-checks only the locked row; it never re-scans for a newer, higher-id
 * tail). Only a real Postgres reproduces it.
 *
 * WARP-3011: the same goes for what the INSERT stores. Prisma's Json write
 * rounding a refs number to 16 digits happens inside the query engine, so
 * the exactness cases below need the real client and a real jsonb column.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane (no DB) skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ActivityChainPreconditionError,
  appendActivityRowInTx,
  createActivityRecorder,
  type RecordParams,
} from "./activity.service.js";
import { createHmacSigner, hashSignature } from "./audit-signing.service.js";
import { verifyActivityChain } from "./audit-verify.service.js";
import { _setActivityRecorderForTests, recordActivityInTx } from "./activity.singleton.js";
import {
  SecurityAuditUnavailableError,
  auditSecurityInTx,
  isSecurityAuditUnavailable,
} from "./security-audit.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so
// the DB-less lane never needs Postgres. This file is the opposite: it
// must talk to a REAL Postgres, so undo the mock for this module and pull
// the real client in at runtime.
vi.unmock("@prisma/client");

/** Where Prisma puts its transaction's id on an interactive-transaction client — the append queue's key. */
const PRISMA_TX_ID = Symbol.for("prisma.client.transaction.id");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)(
  "activity recorder — real-Postgres concurrency (WARP-1026)",
  () => {
    let prisma: PrismaClient;
    const signer = createHmacSigner(Buffer.alloc(32, 7));

    beforeAll(async () => {
      const { PrismaClient: RealPrismaClient } = await vi.importActual<
        typeof import("@prisma/client")
      >("@prisma/client");
      prisma = new RealPrismaClient();
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ActivityRow" RESTART IDENTITY',
      );
    });

    it("25 concurrent record() calls never fork the chain", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      // Seed one row so every concurrent writer contends on a real tail.
      await recorder.record({
        kind: "system",
        severity: "info",
        sourceIcon: "activity",
        what: "seed",
        actor: { type: "system" },
      });

      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          recorder.record({
            kind: "system",
            severity: "info",
            sourceIcon: "activity",
            what: `concurrent write ${i}`,
            actor: { type: "system" },
          }),
        ),
      );

      const rows = await prisma.activityRow.findMany({
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(26);

      // A fork = two rows chaining from the same predecessor. Under a
      // correct recorder every prevSignatureHash is unique...
      const prevs = rows.map((r) => r.prevSignatureHash);
      expect(new Set(prevs).size).toBe(prevs.length);

      // ...and, stronger, every row links to the row IMMEDIATELY before
      // it in id order (lock-acquisition order == insertion order).
      expect(rows[0]!.prevSignatureHash).toBe("");
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.prevSignatureHash).toBe(
          hashSignature(rows[i - 1]!.signature),
        );
      }
    });

    it("concurrent genesis writers on an empty table produce exactly one origin row", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          recorder.record({
            kind: "system",
            severity: "info",
            sourceIcon: "activity",
            what: `genesis race ${i}`,
            actor: { type: "system" },
          }),
        ),
      );
      const rows = await prisma.activityRow.findMany({
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(10);
      const genesisRows = rows.filter((r) => r.prevSignatureHash === "");
      expect(genesisRows).toHaveLength(1);
      expect(genesisRows[0]!.id).toBe(rows[0]!.id);
    });

    // WARP-3011 — Prisma 5.22's Json WRITE keeps 16 significant digits, so a
    // refs number that needs 17 was stored as a different value (0.1 + 0.2
    // as 0.3, 1.7976931348623157e308 as null) while the signature covers the
    // original: verification failed on that row, and so on the whole chain
    // after it, forever. The recorder now binds the canonical text itself.
    it("refs numbers that need 17 significant digits are stored exactly, and the chain verifies (WARP-3011)", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      const refs = {
        sum: 0.1 + 0.2,
        // An openWakeWord float32 score widened to a double, as routes/voice.ts
        // records it — about one in four of those needs 17 digits.
        score: Math.fround(0.123),
        nested: { list: [123.45600000000002, 5e-324, -1.5e-30] },
        max: 1.7976931348623157e308,
        big: 2 ** 64,
      };
      const row = await recorder.record({
        kind: "voice",
        severity: "info",
        sourceIcon: "mic",
        what: "Wake word heard",
        refs,
        actor: { type: "system" },
      });

      // The column holds every digit...
      const raw = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
        'SELECT "refs"::text AS t FROM "ActivityRow" WHERE "id" = $1',
        row.id,
      );
      expect(JSON.parse(raw[0]!.t)).toEqual(refs);
      // ...Prisma reads it back exactly...
      const found = await prisma.activityRow.findUnique({ where: { id: row.id } });
      expect(found!.refs).toEqual(refs);
      expect((found!.refs as { sum: number }).sum).toBe(0.1 + 0.2);
      expect(row.refs).toEqual(refs);
      // ...and the chain verifies.
      await expect(verifyActivityChain(prisma, signer)).resolves.toEqual({
        ok: true,
        rowsChecked: 1,
        brokenAtId: null,
      });
    });

    it("every other column lands exactly as Prisma's own write stored it (WARP-3011)", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      const at = new Date("2026-09-23T12:34:56.789Z");
      const actorId = "11111111-1111-4111-8111-111111111111";
      const row = await recorder.record({
        kind: "auth",
        severity: "warn",
        sourceIcon: "log-in",
        what: "Sign-in throttled",
        sub: "from 192.168.50.42",
        actor: { type: "user", id: actorId },
        at,
      });
      expect(typeof row.id).toBe("bigint");

      const found = await prisma.activityRow.findUnique({ where: { id: row.id } });
      expect(found).toEqual({
        id: row.id,
        at,
        severity: "warn",
        sourceIcon: "log-in",
        what: "Sign-in throttled",
        sub: "from 192.168.50.42",
        kind: "auth",
        refs: null,
        signature: row.signature,
        prevSignatureHash: "",
        actorType: "user",
        actorId,
        schemaVersion: 2,
      });
      // No refs is SQL NULL, never the JSON value null.
      const isNull = await prisma.$queryRawUnsafe<Array<{ n: boolean }>>(
        'SELECT "refs" IS NULL AS n FROM "ActivityRow" WHERE "id" = $1',
        row.id,
      );
      expect(isNull[0]!.n).toBe(true);
      await expect(verifyActivityChain(prisma, signer)).resolves.toMatchObject({ ok: true });
    });

    it("`at` bound as ISO text is stored as UTC wall-clock whatever the session TimeZone", async () => {
      // The recorder's INSERT casts `$1::timestamp(3)`; that cast ignores the
      // `Z` rather than converting through the session TimeZone.
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
        return tx.$queryRawUnsafe<Array<{ t: string }>>(
          "SELECT $1::timestamp(3)::text AS t",
          "2026-09-23T12:34:56.789Z",
        );
      });
      expect(rows[0]!.t).toBe("2026-09-23 12:34:56.789");
    });

    // ── WARP-2977 P2b: the in-transaction append (one code path) ──────────

    const AT = new Date("2026-09-24T09:00:00.000Z");
    const CHAIN: RecordParams[] = [
      {
        kind: "system",
        severity: "info",
        sourceIcon: "shield",
        what: "Security: closed up",
        actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
        refs: { surface: "security", action: "mode.close", until: "2026-09-25T08:00:00.000Z", nested: { a: [1, "b", null] } },
        at: AT,
      },
      { kind: "auth", severity: "ok", sourceIcon: "log-in", what: "signed in", sub: "from lan", actor: { type: "anonymous" }, at: new Date(AT.getTime() + 1000) },
      { kind: "system", severity: "info", sourceIcon: "shield", what: "Security: set to away", actor: { type: "system" }, at: new Date(AT.getTime() + 2000) },
    ];

    async function stored() {
      return prisma.activityRow.findMany({ orderBy: { id: "asc" } });
    }

    it("rows appended inside a caller's transaction are byte-identical to record()'s", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      for (const p of CHAIN) await recorder.record(p);
      const viaRecord = await stored();

      // Back to an empty chain by deleting exactly those rows (this file's
      // beforeEach started it empty), never a second TRUNCATE: the in-tx rows
      // then start from the same genesis. Only the ids differ.
      await prisma.activityRow.deleteMany({ where: { id: { in: viaRecord.map((r) => r.id) } } });
      for (const p of CHAIN) {
        await prisma.$transaction((tx) => appendActivityRowInTx(tx, signer, p));
      }
      const viaTx = await stored();

      expect(viaTx).toHaveLength(CHAIN.length);
      // Every column but the id, as Postgres stores it — the JSON refs and the signature included.
      const withoutId = (rows: typeof viaRecord) => rows.map(({ id: _id, ...rest }) => rest);
      expect(withoutId(viaTx)).toEqual(withoutId(viaRecord));
      expect((await verifyActivityChain(prisma, signer)).ok).toBe(true);
    });

    it("params that are not plain literals store what 61fa4aebe stored — getters, inherited and non-enumerable fields, through record() and in-tx", async () => {
      // Measured at 3fe6e6837 (a spread snapshot): the getter actor and the
      // inherited type threw, the non-enumerable ai id was stored NULL on a
      // row that verified, the getter `what` failed Prisma's validation.
      class GetterActor {
        get type(): "ai" {
          return "ai";
        }
        get id(): string {
          return "33333333-3333-4333-8333-333333333333";
        }
      }
      class GetterWhat {
        kind = "system" as const;
        severity = "info" as const;
        sourceIcon = "shield";
        actor = { type: "system" as const };
        get what(): string {
          return "from a getter";
        }
      }
      const hidden = (type: "ai" | "user", id: string) => {
        const a = { type } as RecordParams["actor"];
        Object.defineProperty(a, "id", { value: id, enumerable: false });
        return a;
      };
      const params = (): RecordParams[] => [
        { ...sys("getter actor"), actor: new GetterActor() },
        { ...sys("non-enumerable ai id"), actor: hidden("ai", "44444444-4444-4444-8444-444444444444") },
        { ...sys("non-enumerable user id"), actor: hidden("user", "55555555-5555-4555-8555-555555555555") },
        { ...sys("inherited actor type"), actor: Object.create({ type: "system" }) as RecordParams["actor"] },
        new GetterWhat(),
      ];
      const expected = [
        ["getter actor", "ai", "33333333-3333-4333-8333-333333333333"],
        ["non-enumerable ai id", "ai", "44444444-4444-4444-8444-444444444444"],
        ["non-enumerable user id", "user", "55555555-5555-4555-8555-555555555555"],
        ["inherited actor type", "system", null],
        ["from a getter", "system", null],
      ];
      const recorder = createActivityRecorder({ prisma, signer });
      for (const p of params()) await recorder.record(p);
      for (const p of params()) await prisma.$transaction((tx) => appendActivityRowInTx(tx, signer, p), READ_COMMITTED_TX);
      const rows = await stored();
      expect(rows.map((r) => [r.what, r.actorType, r.actorId])).toEqual([...expected, ...expected]);
      linear(rows);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 10, brokenAtId: null });
    });

    it("a rolled-back caller transaction leaves no ActivityRow, and the chain still verifies", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      await recorder.record(CHAIN[0]!);
      await expect(
        prisma.$transaction(async (tx) => {
          await appendActivityRowInTx(tx, signer, CHAIN[1]!);
          // The security change after its audit append fails → both roll back.
          throw new Error("change refused");
        }),
      ).rejects.toThrow("change refused");
      expect(await prisma.activityRow.count()).toBe(1);

      await recorder.record(CHAIN[2]!);
      const rows = await stored();
      expect(rows).toHaveLength(2);
      expect(rows[1]!.prevSignatureHash).toBe(hashSignature(rows[0]!.signature));
      const verdict = await verifyActivityChain(prisma, signer);
      expect(verdict).toEqual({ ok: true, rowsChecked: 2, brokenAtId: null });
    });

    it("in-transaction appends racing record() never fork the chain", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      await recorder.record(CHAIN[2]!);
      await Promise.all(
        Array.from({ length: 16 }, (_, i) => {
          const p: RecordParams = {
            kind: "system",
            severity: "info",
            sourceIcon: "shield",
            what: `race ${i}`,
            actor: { type: "system" },
          };
          return i % 2 === 0
            ? recorder.record(p)
            : prisma.$transaction((tx) => appendActivityRowInTx(tx, signer, p));
        }),
      );
      const rows = await stored();
      expect(rows).toHaveLength(17);
      expect(new Set(rows.map((r) => r.prevSignatureHash)).size).toBe(17);
      expect((await verifyActivityChain(prisma, signer)).ok).toBe(true);
    });

    // ── WARP-2977 P2b: the append's preconditions, on the real database ───
    //
    // A Security write is `CAS on its row → audit LAST`, so the caller's
    // transaction has ALWAYS run a statement (taken a snapshot) before it
    // waits for the chain lock. Under READ COMMITTED the tail read after the
    // lock takes a fresh snapshot; under REPEATABLE READ / SERIALIZABLE it
    // reuses the caller's first one, misses the rows committed during the
    // wait and forks the chain — and SSI does not abort it, because the other
    // writer (record()) runs at READ COMMITTED. So the append refuses them.

    const TAG = "warp2977b-activity-";

    // Any row a caller compare-and-sets before its audit will do; this file
    // owns a tiny probe table rather than borrowing a feature's model, so the
    // audit chain's tests stand on their own.
    const CAS_TABLE = `"warp2977b_cas_probe"`;

    async function taggedZones(n: number): Promise<string[]> {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${CAS_TABLE} ("id" text PRIMARY KEY, "version" integer NOT NULL DEFAULT 0)`,
      );
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = `${TAG}${i}`;
        await prisma.$executeRawUnsafe(`INSERT INTO ${CAS_TABLE} ("id") VALUES ($1)`, id);
        ids.push(id);
      }
      return ids;
    }

    async function dropTaggedZones(): Promise<void> {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${CAS_TABLE}`);
    }

    /** The caller's compare-and-set: bumps the probe row only at the expected version. */
    function casProbe(tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> }, id: string) {
      return tx.$executeRawUnsafe(`UPDATE ${CAS_TABLE} SET "version" = "version" + 1 WHERE "id" = $1 AND "version" = 0`, id);
    }

    function linear(rows: Array<{ signature: string; prevSignatureHash: string }>): void {
      expect(rows[0]!.prevSignatureHash).toBe("");
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.prevSignatureHash).toBe(hashSignature(rows[i - 1]!.signature));
      }
    }

    const sys = (what: string): RecordParams => ({ kind: "system", severity: "info", sourceIcon: "shield", what, actor: { type: "system" } });

    it("the database default isolation is READ COMMITTED — the level record()'s own transaction runs at", async () => {
      const def = await prisma.$queryRawUnsafe<Array<{ d: string }>>(
        "SELECT current_setting('default_transaction_isolation') AS d",
      );
      expect(def[0]!.d).toBe("read committed");
      const inTx = await prisma.$transaction((tx) =>
        tx.$queryRawUnsafe<Array<{ iso: string }>>("SELECT current_setting('transaction_isolation') AS iso"),
      );
      expect(inTx[0]!.iso).toBe("read committed");
      // …and record() therefore passes its own check.
      const row = await createActivityRecorder({ prisma, signer }).record(sys("default level"));
      expect(row.prevSignatureHash).toBe("");
    });

    it("record() states READ COMMITTED, so it writes on a client whose default isolation is Serializable (s0-rereview-3)", async () => {
      const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
      const serializableByDefault = new RealPrismaClient({ transactionOptions: { isolationLevel: "Serializable" } });
      await serializableByDefault.$connect();
      try {
        // The client's default really is Serializable…
        const iso = await serializableByDefault.$transaction((tx) =>
          tx.$queryRawUnsafe<Array<{ iso: string }>>("SELECT current_setting('transaction_isolation') AS iso"),
        );
        expect(iso[0]!.iso).toBe("serializable");
        // …and the in-tx append on it is refused, as it must be…
        await expect(
          serializableByDefault.$transaction((tx) => appendActivityRowInTx(tx, signer, sys("inherits serializable"))),
        ).rejects.toBeInstanceOf(ActivityChainPreconditionError);
        // …but record() never inherits it: every row lands, linear and verified.
        const recorder = createActivityRecorder({ prisma: serializableByDefault, signer });
        await recorder.record(sys("r1"));
        await Promise.all([2, 3, 4].map((i) => recorder.record(sys(`r${i}`))));
        const rows = await stored();
        expect(rows.map((r) => r.what).sort()).toEqual(["r1", "r2", "r3", "r4"]);
        linear(rows);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
      } finally {
        await serializableByDefault.$disconnect();
      }
    });

    it("a real interactive-transaction client has no $transaction; the bare client does", async () => {
      expect("$transaction" in prisma).toBe(true);
      await prisma.$transaction(async (tx) => {
        expect("$transaction" in tx).toBe(false);
      });
    });

    it("the documented shape (CAS row lock, THEN the in-tx append) chains from a row committed after its first statement", async () => {
      await dropTaggedZones();
      const [zoneId] = await taggedZones(1);
      const recorder = createActivityRecorder({ prisma, signer });
      await recorder.record(sys("seed"));
      try {
        await prisma.$transaction(async (tx) => {
          expect(await casProbe(tx, zoneId!)).toBe(1);
          // Another writer commits AFTER this transaction's first statement
          // (and before it takes the chain lock) — exactly the window
          // REPEATABLE READ would miss.
          await recorder.record(sys("committed during the caller's transaction"));
          await appendActivityRowInTx(tx, signer, sys("the caller's audit, last"));
        }, READ_COMMITTED_TX);
        const rows = await stored();
        expect(rows.map((r) => r.what)).toEqual(["seed", "committed during the caller's transaction", "the caller's audit, last"]);
        linear(rows);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 3, brokenAtId: null });
      } finally {
        await dropTaggedZones();
      }
    });

    it("the documented shape racing record() under load stays linear and verifies", async () => {
      await dropTaggedZones();
      const zones = await taggedZones(12);
      const recorder = createActivityRecorder({ prisma, signer });
      await recorder.record(sys("seed"));
      try {
        await Promise.all([
          ...zones.map((id, i) =>
            prisma.$transaction(async (tx) => {
              expect(await casProbe(tx, id)).toBe(1);
              return appendActivityRowInTx(tx, signer, sys(`in-tx ${i}`));
            }, { ...READ_COMMITTED_TX, timeout: 30_000, maxWait: 30_000 }),
          ),
          ...Array.from({ length: 12 }, (_, i) => recorder.record(sys(`record ${i}`))),
        ]);
        const rows = await stored();
        expect(rows).toHaveLength(25);
        expect(new Set(rows.map((r) => r.prevSignatureHash)).size).toBe(25);
        linear(rows);
        expect((await verifyActivityChain(prisma, signer)).ok).toBe(true);
      } finally {
        await dropTaggedZones();
      }
    });

    it.each([["RepeatableRead"], ["Serializable"]] as const)(
      "a %s caller is refused after its first statement, writes no row, and the chain still verifies",
      async (isolationLevel) => {
        const recorder = createActivityRecorder({ prisma, signer });
        await recorder.record(sys("seed"));
        const attempt = prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe("SELECT 1"); // the caller's snapshot
          await recorder.record(sys("committed during the caller's transaction"));
          return appendActivityRowInTx(tx, signer, sys("would chain from a stale tail"));
        }, { isolationLevel });
        await expect(attempt).rejects.toBeInstanceOf(ActivityChainPreconditionError);
        await expect(attempt).rejects.toThrow(/READ COMMITTED/);
        const rows = await stored();
        expect(rows.map((r) => r.what)).toEqual(["seed", "committed during the caller's transaction"]);
        linear(rows);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 2, brokenAtId: null });
      },
    );

    it("a bare client is refused before any statement, and writes no row", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      await expect(appendActivityRowInTx(prisma as never, signer, sys("autocommit"))).rejects.toBeInstanceOf(
        ActivityChainPreconditionError,
      );
      expect(await prisma.activityRow.count()).toBe(1);
    });

    it("the bare client's methods on an object without $transaction are refused too — no transaction id — before any statement", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      // It type-checks as an append handle and passes the shape check; every
      // statement autocommits, and each still reports 'read committed'.
      const autocommit = { $queryRawUnsafe: prisma.$queryRawUnsafe.bind(prisma), activityRow: prisma.activityRow };
      const one = appendActivityRowInTx(autocommit, signer, sys("autocommit, alone"));
      await expect(one).rejects.toBeInstanceOf(ActivityChainPreconditionError);
      await expect(one).rejects.toThrow(/transaction id/);
      // 24 at once — measured forking 11 to 15 links before any check.
      const many = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) => appendActivityRowInTx(autocommit, signer, sys(`autocommit ${i}`))),
      );
      expect(many.every((r) => r.status === "rejected" && r.reason instanceof ActivityChainPreconditionError)).toBe(true);
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
      // Not one statement ran: no advisory lock was ever taken on this backend's behalf.
      const locks = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'");
      expect(Number(locks[0]!.n)).toBe(0);
    });

    it("second layer: an autocommitting handle that carries a (forged) transaction id is refused by transaction_timestamp, 1 and 24 at once", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      const forged = {
        $queryRawUnsafe: prisma.$queryRawUnsafe.bind(prisma),
        activityRow: prisma.activityRow,
        [PRISMA_TX_ID]: "forged-transaction-id",
      };
      const one = appendActivityRowInTx(forged, signer, sys("forged, alone"));
      await expect(one).rejects.toBeInstanceOf(ActivityChainPreconditionError);
      await expect(one).rejects.toThrow(/different transactions/);
      // 24 at once on one forged id — the queue serialises them, and each is still refused.
      const many = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) => appendActivityRowInTx(forged, signer, sys(`forged ${i}`))),
      );
      expect(many.every((r) => r.status === "rejected" && r.reason instanceof ActivityChainPreconditionError)).toBe(true);
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
    });

    // ── WARP-2977 P2b: the queue's key is Prisma's transaction id ─────────
    //
    // The per-transaction append queue is keyed on the id Prisma puts on its
    // interactive-transaction client. These pin that the id exists where the
    // append looks for it — on a plain tx AND on an $extends client's tx — so
    // a Prisma upgrade that drops or renames it turns this lane red (and every
    // append fails closed) instead of silently un-serialising appends.

    it("Prisma's interactive-transaction client carries a unique transaction id; an $extends client's does too; the bare client does not", async () => {
      const idOf = (h: unknown): unknown => (h as Record<symbol, unknown>)[PRISMA_TX_ID];
      expect(idOf(prisma)).toBeUndefined();
      const ids = await Promise.all([1, 2, 3].map(() => prisma.$transaction(async (tx) => idOf(tx))));
      for (const id of ids) {
        expect(typeof id).toBe("string");
        expect(id).not.toBe("");
      }
      expect(new Set(ids).size).toBe(3);
      // The same id for the whole callback.
      await prisma.$transaction(async (tx) => {
        expect(idOf(tx)).toBe(idOf(tx));
        // A wrapper of bound methods does not carry it.
        expect(idOf({ $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx), activityRow: tx.activityRow })).toBeUndefined();
      });

      const extClient = prisma.$extends({ client: { $marker: () => "ext" } });
      const extQuery = prisma.$extends({ query: { activityRow: { async create({ args, query }) { return query(args); } } } });
      expect(idOf(extClient)).toBeUndefined();
      const extIds = await Promise.all([
        extClient.$transaction(async (tx) => idOf(tx)),
        extClient.$transaction(async (tx) => idOf(tx)),
        extQuery.$transaction(async (tx) => idOf(tx)),
      ]);
      for (const id of extIds) {
        expect(typeof id).toBe("string");
        expect(id).not.toBe("");
      }
      expect(new Set([...ids, ...extIds]).size).toBe(6);
    });

    it("an $extends client's tx appends — Promise.all of three chains linearly and verifies", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      const ext = prisma.$extends({ query: { activityRow: { async create({ args, query }) { return query(args); } } } });
      // An $extends client's tx is not typed as Prisma.TransactionClient (its
      // delegates carry the extension's generics); what is pinned here is the
      // runtime path, so it is cast.
      await ext.$transaction(
        (extTx) => {
          const tx = extTx as unknown as Prisma.TransactionClient;
          return Promise.all([
            appendActivityRowInTx(tx, signer, sys("x1")),
            appendActivityRowInTx(tx, signer, sys("x2")),
            appendActivityRowInTx(tx, signer, sys("x3")),
          ]);
        },
        READ_COMMITTED_TX,
      );
      const rows = await stored();
      expect(rows.map((r) => r.what)).toEqual(["seed", "x1", "x2", "x3"]);
      linear(rows);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
    });

    it("Promise.all of three appends, each through a FRESH wrapper built from the real tx, is refused: 0 rows, the chain verifies", async () => {
      // The review's shape, measured forking on the handle-keyed queue: 4
      // rows, 2 duplicate predecessors, verify {ok:false, brokenAtId:'3'}.
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      const attempt = prisma.$transaction(
        (tx) =>
          Promise.all(
            [1, 2, 3].map((i) =>
              appendActivityRowInTx({ $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx), activityRow: tx.activityRow }, signer, sys(`w${i}`)),
            ),
          ),
        READ_COMMITTED_TX,
      );
      await expect(attempt).rejects.toBeInstanceOf(ActivityChainPreconditionError);
      await expect(attempt).rejects.toThrow(/transaction id/);
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
    });

    it("…through Security audits too, and a real tx passed directly still chains linearly", async () => {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      try {
        await createActivityRecorder({ prisma, signer }).record(sys("seed"));
        const refused = prisma.$transaction(
          (tx) =>
            Promise.all(
              [1, 2, 3].map((i) =>
                auditSecurityInTx({ $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx), activityRow: tx.activityRow }, USER_REQ, {
                  action: "zone.update",
                  what: `w${i}`,
                }),
              ),
            ),
          READ_COMMITTED_TX,
        );
        // A programming error, never AUDIT_UNAVAILABLE.
        await expect(refused).rejects.toBeInstanceOf(ActivityChainPreconditionError);
        await expect(refused).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
        await prisma.$transaction(
          (tx) => Promise.all([1, 2, 3].map((i) => auditSecurityInTx(tx, USER_REQ, { action: "zone.update", what: `d${i}` }))),
          READ_COMMITTED_TX,
        );
        const rows = await stored();
        expect(rows.map((r) => r.what)).toEqual(["seed", "d1", "d2", "d3"]);
        linear(rows);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    it("a COPY of the real tx ({...tx}, Object.assign, {...tx, requestId}) keeps the id but not the methods: refused before any statement — a 500-class precondition, never AUDIT_UNAVAILABLE (s0-rereview-3)", async () => {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      try {
        await createActivityRecorder({ prisma, signer }).record(sys("seed"));
        const copies: Array<[string, (tx: Prisma.TransactionClient) => unknown]> = [
          ["{...tx}", (tx) => ({ ...tx })],
          ["Object.assign({}, tx)", (tx) => Object.assign({}, tx)],
          ["{...tx, requestId}", (tx) => ({ ...tx, requestId: "req-1" })],
        ];
        for (const [name, copy] of copies) {
          const seen: { copy?: Record<symbol, unknown> } = {};
          const attempt = prisma.$transaction(async (tx) => {
            seen.copy = copy(tx) as Record<symbol, unknown>;
            return auditSecurityInTx(seen.copy as never, USER_REQ, { action: "zone.update", what: `copy ${name}` });
          }, READ_COMMITTED_TX);
          await expect(attempt, name).rejects.toBeInstanceOf(ActivityChainPreconditionError);
          await expect(attempt, name).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
          await expect(attempt, name).rejects.toThrow(/transaction client itself/);
          const err = await attempt.catch((e: unknown) => e);
          expect(isSecurityAuditUnavailable(err), name).toBe(false);
          // The premise, on the real client: the copy DOES carry the id.
          expect(typeof seen.copy?.[PRISMA_TX_ID], name).toBe("string");
        }
        expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
        const locks = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'");
        expect(Number(locks[0]!.n)).toBe(0);
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    it("the queue is keyed on the TRANSACTION, not the object: fresh wrappers that forward the tx's id chain linearly, in call order", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      // Three distinct handle objects on one transaction. Keyed by object,
      // each got its own queue and they forked; keyed by the id, they queue.
      const forwarding = (tx: Prisma.TransactionClient) => ({
        $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
        activityRow: tx.activityRow,
        [PRISMA_TX_ID]: (tx as unknown as Record<symbol, unknown>)[PRISMA_TX_ID],
      });
      await prisma.$transaction(
        (tx) =>
          Promise.all([
            appendActivityRowInTx(forwarding(tx), signer, sys("s1")),
            appendActivityRowInTx(forwarding(tx), signer, sys("s2")),
            appendActivityRowInTx(forwarding(tx), signer, sys("s3")),
          ]),
        READ_COMMITTED_TX,
      );
      const rows = await stored();
      expect(rows.map((r) => r.what)).toEqual(["seed", "s1", "s2", "s3"]);
      expect(new Set(rows.map((r) => r.prevSignatureHash)).size).toBe(4);
      linear(rows);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
    });

    // ── WARP-2977 P2b: several appends on ONE transaction ─────────────────
    //
    // pg_advisory_xact_lock is re-entrant within one backend, so it cannot
    // serialise two appends running concurrently on the same transaction:
    // measured before the in-process queue, `Promise.all` of three audits on
    // one tx committed 4 rows with 2 duplicate predecessors, and
    // verifyActivityChain = {ok: false, brokenAtId: '3'} for good.

    const USER_REQ = { user: { id: "11111111-1111-4111-8111-111111111111", role: "owner" } };

    it("Promise.all of three Security audits on one transaction chains linearly, in call order, and verifies", async () => {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      try {
        await createActivityRecorder({ prisma, signer }).record(sys("seed"));
        await prisma.$transaction(
          (tx) =>
            Promise.all([
              auditSecurityInTx(tx, USER_REQ, { action: "zone.update", what: "p1" }),
              auditSecurityInTx(tx, USER_REQ, { action: "zone.update", what: "p2" }),
              auditSecurityInTx(tx, USER_REQ, { action: "zone.update", what: "p3" }),
            ]),
          READ_COMMITTED_TX,
        );
        const rows = await stored();
        expect(rows.map((r) => r.what)).toEqual(["seed", "p1", "p2", "p3"]);
        expect(new Set(rows.map((r) => r.prevSignatureHash)).size).toBe(4);
        linear(rows);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    it("a rejected append in the middle does not wedge the next one on the same transaction", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      // Fails after taking the (re-entrant) lock and reading the tail, before
      // any failing SQL — so the transaction itself stays usable. (allSettled
      // here only to observe each outcome; a route must never use it — see
      // the next test.)
      const failing = {
        ...signer,
        sign(): string {
          throw new Error("signer down");
        },
      };
      const settled = await prisma.$transaction(
        (tx) =>
          Promise.allSettled([
            appendActivityRowInTx(tx, signer, sys("p1")),
            appendActivityRowInTx(tx, failing, sys("p2 (fails)")),
            appendActivityRowInTx(tx, signer, sys("p3")),
          ]),
        READ_COMMITTED_TX,
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      const rows = await stored();
      expect(rows.map((r) => r.what)).toEqual(["seed", "p1", "p3"]);
      linear(rows);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 3, brokenAtId: null });
    });

    it("a rejection that REACHED the database aborts the whole transaction: Promise.all rejects; allSettled would resolve over a rollback", async () => {
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      // U+0000 in `what`: Postgres refuses the INSERT (22021), which aborts
      // the transaction; every later statement on it fails 25P02.
      const bad = (): RecordParams => sys("p2 \u0000 refused by Postgres");
      // The route contract — Promise.all: the rejection propagates, $transaction rejects.
      await expect(
        prisma.$transaction(
          (tx) => Promise.all([appendActivityRowInTx(tx, signer, sys("p1")), appendActivityRowInTx(tx, signer, bad()), appendActivityRowInTx(tx, signer, sys("p3"))]),
          READ_COMMITTED_TX,
        ),
      ).rejects.toThrow();
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      // Why never allSettled: `$transaction` RESOLVES — p1 even reports
      // fulfilled — while Postgres rolled all of it back (COMMIT on an aborted
      // transaction is a ROLLBACK). A route would answer 200 for a change that
      // never happened.
      const settled = await prisma.$transaction(
        (tx) => Promise.allSettled([appendActivityRowInTx(tx, signer, sys("q1")), appendActivityRowInTx(tx, signer, bad()), appendActivityRowInTx(tx, signer, sys("q3"))]),
        READ_COMMITTED_TX,
      );
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "rejected"]);
      expect(String((settled[2] as PromiseRejectedResult).reason)).toMatch(/25P02|current transaction is aborted/);
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
    });

    it("safe-integer refs round-trip through a Security audit and verify; a 17-digit double is refused by securityRefs before any statement", async () => {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      try {
        const refs = { max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER, zero: 0, negZero: -0, minutes: 90, list: [1, -2, 3] };
        const row = await prisma.$transaction(
          (tx) => auditSecurityInTx(tx, USER_REQ, { action: "hours.set", what: "Security: opening hours changed", refs }),
          READ_COMMITTED_TX,
        );
        const back = await prisma.activityRow.findUniqueOrThrow({ where: { id: row.id } });
        expect(back.refs).toEqual({ ...refs, negZero: 0, surface: "security", action: "hours.set" });
        // In the table itself, not only through the client.
        const text = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
          'SELECT "refs"::text AS t FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1',
        );
        expect(text[0]!.t).toContain("9007199254740991");
        expect(text[0]!.t).toContain("-9007199254740991");
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });

        // securityRefs keeps Security refs to safe integers (minutes, versions,
        // counts): a fraction is refused as bad input (a 500), never
        // AUDIT_UNAVAILABLE. (The chain itself stores any finite double exactly
        // since WARP-3011 — see the float32 cases above.)
        const bad = prisma.$transaction(
          (tx) => auditSecurityInTx(tx, USER_REQ, { action: "hours.set", what: "x", refs: { n: 0.1 + 0.2 } }),
          READ_COMMITTED_TX,
        );
        await expect(bad).rejects.toThrow(/at n is not a safe integer/);
        await expect(bad).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
        expect(await prisma.activityRow.count()).toBe(1);
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    // ── WARP-3011 on the in-transaction path ─────────────────────────────
    //
    // record() and every in-tx caller (recordActivityInTx, so auditSecurityInTx
    // and the Security services) share appendActivityRowInTx's one INSERT. A
    // float32 value widened to a double — an openWakeWord score — needs 17
    // significant digits; Prisma's Json write kept 16 and broke the chain.

    it("a float32 ref appended in a caller's transaction is stored exactly and the chain verifies (golden)", async () => {
      const recorder = createActivityRecorder({ prisma, signer });
      _setActivityRecorderForTests(recorder, signer);
      try {
        await recorder.record(sys("seed"));
        // The golden value: 0.1 as a float32, widened to a double.
        const score = Math.fround(0.1);
        expect(score).toBe(0.10000000149011612);
        const refs = { score, threshold: Math.fround(0.5), sum: 0.1 + 0.2, nested: { list: [Math.fround(0.123), 2 ** 64] } };
        const voice = (what: string, r: Record<string, unknown>): RecordParams => ({
          kind: "voice",
          severity: "info",
          sourceIcon: "mic",
          what,
          refs: r,
          actor: { type: "system" },
        });

        // Straight through appendActivityRowInTx, and through the singleton's
        // recordActivityInTx (the Security audit path) — one transaction each.
        const direct = await prisma.$transaction((tx) => appendActivityRowInTx(tx, signer, voice("in-tx", refs)), READ_COMMITTED_TX);
        const viaSingleton = await prisma.$transaction(
          (tx) => recordActivityInTx(tx, voice("in-tx via recordActivityInTx", { score: Math.fround(0.3) })),
          READ_COMMITTED_TX,
        );

        // The column holds every digit…
        const raw = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
          'SELECT "refs"::text AS t FROM "ActivityRow" WHERE "id" = $1',
          direct.id,
        );
        expect(raw[0]!.t).toContain("0.10000000149011612");
        expect(JSON.parse(raw[0]!.t)).toEqual(refs);
        // …Prisma reads it back exactly, and the returned row says the same.
        const found = await prisma.activityRow.findUniqueOrThrow({ where: { id: direct.id } });
        expect((found.refs as { score: number }).score).toBe(0.10000000149011612);
        expect(found.refs).toEqual(refs);
        expect(direct.refs).toEqual(refs);
        const foundSingleton = await prisma.activityRow.findUniqueOrThrow({ where: { id: viaSingleton.id } });
        expect((foundSingleton.refs as { score: number }).score).toBe(Math.fround(0.3));
        expect(Math.fround(0.3)).toBe(0.30000001192092896);

        // A record() after them chains from the last, and the whole chain verifies.
        await recorder.record(voice("record() after", { score: Math.fround(0.7) }));
        expect((await stored()).map((r) => r.what)).toEqual(["seed", "in-tx", "in-tx via recordActivityInTx", "record() after"]);
        expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    it("a handle assembled from the real tx's id and raw method plus the BARE client's activityRow writes IN the transaction: the caller's rollback removes it", async () => {
      // Before WARP-3011 the INSERT went through `activityRow.create`, so on
      // this handle it autocommitted and outlived the rollback. Every
      // statement now rides `$queryRawUnsafe`, the transaction's own method.
      await createActivityRecorder({ prisma, signer }).record(sys("seed"));
      const rollback = new Error("the caller rolls back");
      const attempt = prisma.$transaction(async (tx) => {
        const assembled = {
          $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
          activityRow: prisma.activityRow,
          [PRISMA_TX_ID]: (tx as unknown as Record<symbol, unknown>)[PRISMA_TX_ID],
        };
        await appendActivityRowInTx(assembled as never, signer, sys("assembled"));
        throw rollback;
      }, READ_COMMITTED_TX);
      await expect(attempt).rejects.toBe(rollback);
      expect((await stored()).map((r) => r.what)).toEqual(["seed"]);
      expect(await verifyActivityChain(prisma, signer)).toEqual({ ok: true, rowsChecked: 1, brokenAtId: null });
    });

    it("a caller transaction that expires waiting for the chain lock is AUDIT_UNAVAILABLE (cause P2028) and writes nothing", async () => {
      _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
      try {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => (locked = r));
        // Holder: appends (takes the chain lock) and keeps its transaction open.
        const holder = prisma.$transaction(async (tx) => {
          await appendActivityRowInTx(tx, signer, sys("holder"));
          locked();
          await held;
        }, { ...READ_COMMITTED_TX, timeout: 20_000 });
        await lockTaken;
        // Waiter: a Security write whose audit waits on that lock past its timeout.
        const waiter = prisma.$transaction(
          (tx) => auditSecurityInTx(tx, { user: { id: "11111111-1111-4111-8111-111111111111", role: "owner" } }, {
            action: "mode.close",
            what: "Security: closed up",
          }),
          { ...READ_COMMITTED_TX, timeout: 600, maxWait: 5_000 },
        );
        // The holder keeps the lock well past the waiter's 600 ms timeout.
        const releaseTimer = setTimeout(() => release(), 1_500);
        const err = await waiter.then(
          () => null,
          (e: unknown) => e,
        );
        clearTimeout(releaseTimer);
        release();
        await holder;
        // Measured on pg16 + Prisma 5.22: the engine expires the transaction
        // while its lock statement waits; when the lock frees, that statement
        // fails P2028 ("Transaction already closed … expired transaction"),
        // which the audit wraps. (Had the append finished just before expiry,
        // the COMMIT would fail and `$transaction` would reject with a bare
        // P2028 instead — the next test pins that one.)
        expect(err).toBeInstanceOf(SecurityAuditUnavailableError);
        expect(((err as Error).cause as { code?: unknown }).code).toBe("P2028");
        expect(isSecurityAuditUnavailable(err)).toBe(true);
        // Let the waiter's backend finish its (rolled-back) statement.
        await new Promise((r) => setTimeout(r, 300));
        const rows = await stored();
        expect(rows.map((r) => r.what)).toEqual(["holder"]);
        expect((await verifyActivityChain(prisma, signer)).ok).toBe(true);
      } finally {
        _setActivityRecorderForTests(null, null);
      }
    });

    it("a bare P2028 thrown by $transaction itself is classified AUDIT_UNAVAILABLE too", async () => {
      // One pooled connection, held by another transaction: the audited write
      // cannot even start within maxWait, and `$transaction` rejects with a
      // raw PrismaClientKnownRequestError P2028 — outside auditSecurityInTx.
      const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set("connection_limit", "1");
      const one = new RealPrismaClient({ datasources: { db: { url: url.toString() } } });
      await one.$connect();
      try {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let started!: () => void;
        const running = new Promise<void>((r) => (started = r));
        const holder = one.$transaction(async (tx) => {
          await tx.$queryRawUnsafe("SELECT 1");
          started();
          await held;
        }, { ...READ_COMMITTED_TX, timeout: 20_000 });
        await running;
        const err = await one
          .$transaction((tx) => appendActivityRowInTx(tx, signer, sys("never starts")), { ...READ_COMMITTED_TX, maxWait: 300 })
          .then(
            () => null,
            (e: unknown) => e,
          );
        release();
        await holder;
        expect((err as { code?: unknown } | null)?.code).toBe("P2028");
        expect(err).not.toBeInstanceOf(SecurityAuditUnavailableError);
        expect(isSecurityAuditUnavailable(err)).toBe(true);
        expect(await prisma.activityRow.count()).toBe(0);
      } finally {
        await one.$disconnect();
      }
    });
  },
);
