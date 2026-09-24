/**
 * WARP-456 — `activity.service.record()` atomic emitter.
 *
 * Verifies the chain semantics on top of an in-memory Prisma fake:
 *   - genesis row has prevSignatureHash = "" and its signature is
 *     computed over content + "".
 *   - every subsequent row reads the most-recent signature and uses
 *     `hashSignature(prev)` as the prev pointer.
 *   - every record() takes the constant chain-append advisory lock
 *     BEFORE reading the tail (WARP-1026). True serialization is proven
 *     against a real Postgres in activity.service.pg.test.ts — this
 *     fake only pins the statement order and shape.
 *
 * The full route-level coverage (signature verify, tamper detection,
 * replay correctness) lives in `activity-chain.test.ts` per AC7.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ActivityChainPreconditionError,
  actorFromRequest,
  appendActivityRowInTx,
  createActivityRecorder,
  snapshotRecordParams,
  validateRecordParams,
  type ActivityActor,
  type ActivityRowRecorder,
  type RecordParams,
} from "./activity.service.js";
import { _setActivityRecorderForTests, recordActivityInTx } from "./activity.singleton.js";
import { SecurityAuditUnavailableError, auditSecurityInTx } from "./security-audit.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";
import {
  canonicalizeRowContent,
  canonicalRefsJson,
  createHmacSigner,
  hashSignature,
  type ActivityRowSigner,
} from "./audit-signing.service.js";
import {
  activityRowCreateTrap,
  activityRowFromInsert,
  isActivityRowInsert,
} from "../__tests__/helpers/activity-row-insert.js";

interface FakeActivityRow {
  id: bigint;
  at: Date;
  severity: "ok" | "warn" | "err" | "info";
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind:
    | "chat"
    | "tool_call"
    | "file"
    | "camera"
    | "network"
    | "smart_home"
    | "email"
    | "auth"
    | "tool_run"
    | "system";
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
  actorType: "user" | "ai" | "system" | "anonymous" | null;
  actorId: string | null;
  schemaVersion: number;
}

/**
 * Where Prisma 5.22 puts the id of ITS transaction on an interactive-transaction
 * client (pinned against the real client in activity.service.pg.test.ts). The
 * append refuses a handle without one and keys its per-transaction queue on it.
 */
const TX_ID: unique symbol = Symbol.for("prisma.client.transaction.id") as never;
/** Unique across every fake in this file, like Prisma's cuids. */
let txSeq = 0;

/** What a Prisma interactive-transaction client offers the append: no `$transaction`, and its transaction's id. */
interface FakeTx {
  /** Present for the append's handle check only; the row goes in through the raw INSERT (WARP-3011). */
  activityRow: {
    create: (args: { data: Record<string, unknown> }) => Promise<FakeActivityRow>;
  };
  $queryRawUnsafe: <T>(query: string, ...params: unknown[]) => Promise<T>;
  readonly [TX_ID]: string;
}

/** The bare client: `$transaction`, and no transaction id. */
interface FakePrisma extends Omit<FakeTx, typeof TX_ID> {
  $transaction: <T>(
    fn: (tx: FakeTx) => Promise<T>,
    options?: { isolationLevel?: string },
  ) => Promise<T>;
}

interface FakeOptions {
  /**
   * What `current_setting('transaction_isolation')` reports in a transaction
   * opened WITHOUT an explicit level — the client's / database's default
   * (WARP-2977 P2b). A `$transaction(fn, {isolationLevel})` reports that
   * level instead, as Postgres does.
   */
  iso?: string | null;
  /** Delay between `$transaction` being called and the callback running (pool checkout + BEGIN). */
  beginDelayMs?: number;
  /**
   * Every statement is its own transaction — the bare client's methods bound
   * onto an object without `$transaction` — so each reports a different
   * `transaction_timestamp()`.
   */
  autocommit?: boolean;
  /**
   * Answers the append's INSERT instead of the table (WARP-3011) — throw to
   * fail the statement, return `[]` for an INSERT that reports no id. Nothing
   * is stored.
   */
  insertResult?: () => unknown;
}

/** What `transaction_timestamp()::text` reports inside one fake transaction. */
const FAKE_TXTS = "2026-09-24 09:00:00.000001+00";

function makePrismaFake(opts: FakeOptions = {}): {
  prisma: FakePrisma;
  /** One transaction's handle, as a `$transaction` callback receives it — what in-tx callers pass. */
  tx: FakeTx;
  /** Another transaction's handle (fresh id) over the same table. */
  makeTx: () => FakeTx;
  rows: FakeActivityRow[];
  transactionCount: { count: number };
  /** The options each `$transaction` was opened with, in order (the seam's record). */
  transactionOptions: () => readonly unknown[];
  queries: string[];
  /** Every parameter list the append's INSERT bound, in order (WARP-3011). */
  insertParams: unknown[][];
} {
  const rows: FakeActivityRow[] = [];
  const transactionCount = { count: 0 };
  const queries: string[] = [];
  const insertParams: unknown[][] = [];
  let nextId = 1n;
  const iso = opts.iso === undefined ? "read committed" : opts.iso;
  let statements = 0;
  const txts = () =>
    opts.autocommit ? `2026-09-24 09:00:00.${String(++statements).padStart(6, "0")}+00` : FAKE_TXTS;

  const methods: Omit<FakeTx, typeof TX_ID> = {
    activityRow: activityRowCreateTrap,
    $queryRawUnsafe: <T>(query: string, ...params: unknown[]) => rawQuery<T>(query, iso, params),
  };
  async function rawQuery<T>(query: string, level: string | null, params: unknown[]): Promise<T> {
    queries.push(query);
    // WARP-3011: the append's INSERT. Keep exactly what the recorder bound
    // — the refs cases assert on the parameter itself.
    if (isActivityRowInsert(query)) {
      if (opts.insertResult) return opts.insertResult() as T;
      insertParams.push(params);
      const row = activityRowFromInsert(nextId++, params) as FakeActivityRow;
      rows.push(row);
      return [{ id: row.id }] as unknown as T;
    }
    // WARP-1026: first call per record() is the chain-append advisory
    // lock; WARP-2977 P2b folds the isolation read and the transaction
    // start time into it.
    if (query.includes("pg_advisory_xact_lock")) {
      return [level === null ? { locked: true, txts: txts() } : { locked: true, iso: level, txts: txts() }] as unknown as T;
    }
    // Tail read: most recent row's signature, id desc — one row even on an
    // empty table (a scalar subquery), with the transaction start time.
    return [{ txts: txts(), signature: rows.length === 0 ? null : rows[rows.length - 1]!.signature }] as unknown as T;
  }
  /** Prisma's isolation level names → what Postgres reports inside the transaction. */
  const LEVEL: Record<string, string> = {
    ReadUncommitted: "read uncommitted",
    ReadCommitted: "read committed",
    RepeatableRead: "repeatable read",
    Serializable: "serializable",
  };
  // Every handle shares the one table; each carries its OWN transaction id,
  // as Prisma's do.
  const makeTx = (level: string | null = iso): FakeTx => ({
    ...methods,
    $queryRawUnsafe: <T>(query: string, ...params: unknown[]) => rawQuery<T>(query, level, params),
    [TX_ID]: `fake-tx-${++txSeq}`,
  });
  const tx = makeTx();
  // WARP-1570: the shared transaction seam (it records the options argument
  // — `transactionOptions()` below). Its client mints a FRESH handle per
  // transaction, never one shared object: the append queue is per
  // transaction, and a shared handle would put every record() in this suite
  // on one queue.
  const seam = createTransactionSeam({ client: () => makeTx() });
  const prisma: FakePrisma = {
    ...methods,
    async $transaction(fn, options) {
      transactionCount.count++;
      if (opts.beginDelayMs) await new Promise((r) => setTimeout(r, opts.beginDelayMs));
      // An explicit level wins over the default, as it does in Postgres.
      const level = options?.isolationLevel !== undefined ? (LEVEL[options.isolationLevel] ?? null) : iso;
      return seam.$transaction(
        (handle: FakeTx) =>
          fn({ ...handle, $queryRawUnsafe: <T>(query: string, ...params: unknown[]) => rawQuery<T>(query, level, params) }),
        options,
      ) as never;
    },
  };
  return { prisma, tx, makeTx, rows, transactionCount, transactionOptions: () => seam.calls(), queries, insertParams };
}

/** The INSERT binds `refs` as its 7th parameter (`$7::jsonb`). */
const REFS_PARAM = 6;

/** Which of the append's three statements a query is: the lock, the tail read or the INSERT. */
function statementKind(query: string): "lock" | "tail" | "insert" {
  if (isActivityRowInsert(query)) return "insert";
  return query.includes("pg_advisory_xact_lock") ? "lock" : "tail";
}

const KEY = Buffer.from("warp-456-test-key-bytes-must-be-long", "utf8");

describe("activity.service.record", () => {
  let signer: ActivityRowSigner;
  let prismaState: ReturnType<typeof makePrismaFake>;
  let recorder: ActivityRowRecorder;

  beforeEach(() => {
    signer = createHmacSigner(KEY);
    prismaState = makePrismaFake();
    recorder = createActivityRecorder({
      prisma: prismaState.prisma as never,
      signer,
    });
  });

  it("genesis row: prevSignatureHash is empty and signature is valid", async () => {
    const row = await recorder.record({
      kind: "auth",
      severity: "ok",
      sourceIcon: "log-in",
      what: "Alice signed in",
      sub: "from 192.168.50.42",
      actor: { type: "user", id: "uuid-alice" },
    });
    expect(prismaState.rows).toHaveLength(1);
    expect(row.prevSignatureHash).toBe("");
    expect(
      signer.verify(
        {
          at: row.at,
          severity: row.severity,
          sourceIcon: row.sourceIcon,
          what: row.what,
          sub: row.sub,
          kind: row.kind,
          refs: row.refs,
          actorType: row.actorType,
          actorId: row.actorId,
          schemaVersion: row.schemaVersion,
        },
        "",
        row.signature,
      ),
    ).toBe(true);
  });

  it("second row: prevSignatureHash = hashSignature(prev.signature)", async () => {
    const first = await recorder.record({
      kind: "chat",
      severity: "ok",
      sourceIcon: "message-square",
      what: "Chat turn completed",
      actor: { type: "user", id: "uuid-alice" },
    });
    const second = await recorder.record({
      kind: "tool_call",
      severity: "ok",
      sourceIcon: "wrench",
      what: "list_files",
      actor: { type: "ai", id: null },
    });
    expect(second.prevSignatureHash).toBe(hashSignature(first.signature));
  });

  it("every record() runs inside a Prisma transaction (atomic chain)", async () => {
    await recorder.record({
      kind: "system",
      severity: "info",
      sourceIcon: "info",
      what: "Boot",
      actor: { type: "system" },
    });
    await recorder.record({
      kind: "system",
      severity: "info",
      sourceIcon: "info",
      what: "Second event",
      actor: { type: "system" },
    });
    expect(prismaState.transactionCount.count).toBe(2);
  });

  it("acquires the chain-append advisory lock before reading the tail (WARP-1026)", async () => {
    await recorder.record({
      kind: "system",
      severity: "info",
      sourceIcon: "info",
      what: "Boot",
      actor: { type: "system" },
    });
    const q = prismaState.queries;
    expect(q[0]).toContain(
      "pg_advisory_xact_lock(hashtext('droplet:activity-chain-append'))",
    );
    expect(q[1]).toContain(
      'SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1',
    );
    expect(q[1]).not.toContain("FOR UPDATE");
    // …and the row goes in with ONE raw INSERT, never Prisma's Json write
    // (WARP-3011), in the same transaction, after the tail read.
    expect(q).toHaveLength(3);
    expect(q[2]).toMatch(/^INSERT INTO "ActivityRow" /);
    expect(q[2]).toContain("$7::jsonb");
  });

  it("binds SQL NULL, never undefined or the text 'null', when there are no refs (WARP-2484)", async () => {
    // An absent refs must land as SQL NULL — the column's "no refs" — not as
    // the JSON value `null`, and not as `undefined`, which the driver would
    // not bind at all.
    const row = await recorder.record({
      kind: "auth",
      severity: "ok",
      sourceIcon: "log-in",
      what: "Alice signed in",
      actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    });

    const bound = prismaState.insertParams[0]!;
    expect(bound).toHaveLength(12);
    expect(bound[REFS_PARAM]).toBeNull();
    expect(row.refs).toBeNull();
  });

  it("binds refs as the exact canonical text the signer signed (WARP-3011)", async () => {
    // 0.1 + 0.2 needs 17 significant digits; Prisma's Json write kept 16 and
    // stored 0.3. The fix: the INSERT carries the very text the HMAC covered.
    const refs = {
      zeta: 0.1 + 0.2,
      alpha: { score: Math.fround(0.123), list: [123.45600000000002, 1] },
      huge: 1.7976931348623157e308,
    };
    const row = await recorder.record({
      kind: "voice",
      severity: "info",
      sourceIcon: "mic",
      what: "Wake word heard",
      refs,
      actor: { type: "system" },
    });

    const bound = prismaState.insertParams[0]![REFS_PARAM];
    expect(bound).toBe(canonicalRefsJson(refs));
    // Byte-identical to the refs inside the string the signature covers.
    const signed = canonicalizeRowContent({
      at: row.at,
      severity: row.severity,
      sourceIcon: row.sourceIcon,
      what: row.what,
      sub: row.sub,
      kind: row.kind,
      refs,
      actorType: row.actorType,
      actorId: row.actorId,
      schemaVersion: row.schemaVersion,
    });
    expect(signed).toContain(`"refs":${bound as string},`);
    // Every digit survives into the bound text; no 16-digit rounding.
    expect(bound).toContain("0.30000000000000004");
    expect(bound).toContain("0.12300000339746475");
    expect(bound).toContain("123.45600000000002");
    expect(bound).toContain("1.7976931348623157e+308");
    // What the row reports is the stored text parsed: the caller's values.
    expect(row.refs).toEqual(refs);
    expect((row.refs as { zeta: number }).zeta).toBe(0.1 + 0.2);
  });

  it("binds every other column from the signed content, `at` as ISO text", async () => {
    const at = new Date("2026-09-23T12:34:56.789Z");
    const row = await recorder.record({
      kind: "auth",
      severity: "warn",
      sourceIcon: "log-in",
      what: "Sign-in throttled",
      sub: "from 192.168.50.42",
      actor: { type: "user", id: "uuid-alice" },
      at,
    });
    expect(prismaState.insertParams[0]).toEqual([
      "2026-09-23T12:34:56.789Z",
      "warn",
      "log-in",
      "Sign-in throttled",
      "from 192.168.50.42",
      "auth",
      null,
      row.signature,
      "",
      "user",
      "uuid-alice",
      2,
    ]);
    expect(row.id).toBe(1n);
    expect(row.at.toISOString()).toBe("2026-09-23T12:34:56.789Z");
  });

  it("refuses to report a row the INSERT did not return an id for", async () => {
    const prisma = makePrismaFake({ insertResult: () => [] }).prisma;
    const broken = createActivityRecorder({ prisma: prisma as never, signer });
    await expect(
      broken.record({
        kind: "system",
        severity: "info",
        sourceIcon: "info",
        what: "Boot",
        actor: { type: "system" },
      }),
    ).rejects.toThrow(/ActivityRow INSERT returned no id/);
  });

  it("refs are persisted and covered by the signature", async () => {
    const row = await recorder.record({
      kind: "tool_call",
      severity: "ok",
      sourceIcon: "wrench",
      what: "block_network_device",
      refs: { mac: "AA:BB:CC:DD:EE:FF", reason: "parental control" },
      actor: { type: "ai", id: null },
    });
    expect(row.refs).toEqual({
      mac: "AA:BB:CC:DD:EE:FF",
      reason: "parental control",
    });
    // Tampering with refs after the fact breaks verification.
    expect(
      signer.verify(
        {
          at: row.at,
          severity: row.severity,
          sourceIcon: row.sourceIcon,
          what: row.what,
          sub: row.sub,
          kind: row.kind,
          refs: { mac: "AA:BB:CC:DD:EE:FF", reason: "parental control" },
          actorType: row.actorType,
          actorId: row.actorId,
          schemaVersion: row.schemaVersion,
        },
        "",
        row.signature,
      ),
    ).toBe(true);
    expect(
      signer.verify(
        {
          at: row.at,
          severity: row.severity,
          sourceIcon: row.sourceIcon,
          what: row.what,
          sub: row.sub,
          kind: row.kind,
          refs: { mac: "AA:BB:CC:DD:EE:FF", reason: "MUTATED" },
          actorType: row.actorType,
          actorId: row.actorId,
          schemaVersion: row.schemaVersion,
        },
        "",
        row.signature,
      ),
    ).toBe(false);
  });

  it("rejects unknown kinds (defense against caller typos)", async () => {
    await expect(
      recorder.record({
        // @ts-expect-error — testing runtime guard
        kind: "totally-made-up",
        severity: "ok",
        sourceIcon: "wrench",
        what: "bogus",
        actor: { type: "system" },
      }),
    ).rejects.toThrow(/unknown ActivityKind/i);
  });

  it("rejects unknown severities", async () => {
    await expect(
      recorder.record({
        kind: "chat",
        // @ts-expect-error — testing runtime guard
        severity: "panic",
        sourceIcon: "wrench",
        what: "bogus",
        actor: { type: "system" },
      }),
    ).rejects.toThrow(/unknown ActivitySeverity/i);
  });

  it("a four-row chain verifies end-to-end", async () => {
    const rows: Awaited<ReturnType<typeof recorder.record>>[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(
        await recorder.record({
          kind: "system",
          severity: "info",
          sourceIcon: "info",
          what: `event-${i}`,
          actor: { type: "system" },
        }),
      );
    }
    // Genesis check.
    expect(rows[0]!.prevSignatureHash).toBe("");
    // Chain links.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevSignatureHash).toBe(
        hashSignature(rows[i - 1]!.signature),
      );
    }
    // Each row verifies under its own prev.
    for (const r of rows) {
      expect(
        signer.verify(
          {
            at: r.at,
            severity: r.severity,
            sourceIcon: r.sourceIcon,
            what: r.what,
            sub: r.sub,
            kind: r.kind,
            refs: r.refs,
            actorType: r.actorType,
            actorId: r.actorId,
            schemaVersion: r.schemaVersion,
          },
          r.prevSignatureHash,
          r.signature,
        ),
      ).toBe(true);
    }
  });
});

// ── WARP-2977 P2b: the in-transaction append is the recorder's own body ──
//
// A Security change and its audit row must commit together, so the chain
// writer was split: `appendActivityRowInTx(tx, signer, params)` is the body
// that locks, reads the tail, signs and inserts; `record()` is validation +
// `$transaction(tx => appendActivityRowInTx(...))`. There must be ONE code
// path — a row appended in a caller's transaction has to be byte-identical to
// the row `record()` would have written, or audit-verify breaks.

const P1 = new Date("2026-09-24T09:00:00.000Z");
const CHAIN_PARAMS: RecordParams[] = [
  { kind: "system", severity: "info", sourceIcon: "shield", what: "Security: closed up", actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" }, refs: { surface: "security", action: "mode.close", modeEffect: { from: "open", to: "closed" }, until: "2026-09-25T08:00:00.000Z" }, at: P1 },
  { kind: "auth", severity: "ok", sourceIcon: "log-in", what: "Alice signed in", sub: "from 192.168.50.42", actor: { type: "user", id: "22222222-2222-4222-8222-222222222222" }, at: new Date(P1.getTime() + 1_000) },
  { kind: "system", severity: "info", sourceIcon: "shield", what: "Security: opening hours took over from a manual Close up", actor: { type: "system" }, refs: { surface: "security", action: "mode.expire", added: [], removed: ["a", "b"] }, at: new Date(P1.getTime() + 2_000) },
  { kind: "tool_call", severity: "ok", sourceIcon: "wrench", what: "list_files", refs: null, actor: { type: "ai", id: null }, at: new Date(P1.getTime() + 3_000) },
];

/** Every byte the chain stores or signs, BigInt-safe. */
function bytes(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
}

describe("appendActivityRowInTx — one code path with record() (WARP-2977 P2b)", () => {
  const signer = createHmacSigner(KEY);

  async function viaRecord(params: RecordParams[]) {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    const returned = [];
    for (const p of params) returned.push(await rec.record(p));
    return { state, returned };
  }

  async function viaInTx(params: RecordParams[], pick: (i: number) => "record" | "tx") {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    const returned = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      returned.push(
        pick(i) === "record"
          ? await rec.record(p)
          : await state.prisma.$transaction((tx) => appendActivityRowInTx(tx as never, signer, p)),
      );
    }
    return { state, returned };
  }

  it("rows appended in a caller's transaction are byte-identical to record()'s", async () => {
    const a = await viaRecord(CHAIN_PARAMS);
    const b = await viaInTx(CHAIN_PARAMS, () => "tx");
    expect(bytes(b.state.rows)).toBe(bytes(a.state.rows));
    expect(bytes(b.returned)).toBe(bytes(a.returned));
    // …down to every parameter the INSERT bound and the SQL issued.
    expect(b.state.insertParams).toEqual(a.state.insertParams);
    expect(b.state.queries).toEqual(a.state.queries);
    // Not vacuous: the signatures are real and chained.
    expect(a.state.rows).toHaveLength(4);
    expect(new Set(a.state.rows.map((r) => r.signature)).size).toBe(4);
    expect(a.state.rows[1]!.prevSignatureHash).toBe(hashSignature(a.state.rows[0]!.signature));
  });

  it("interleaving the two writers yields the same chain as record() alone", async () => {
    const a = await viaRecord(CHAIN_PARAMS);
    const b = await viaInTx(CHAIN_PARAMS, (i) => (i % 2 === 0 ? "tx" : "record"));
    const c = await viaInTx(CHAIN_PARAMS, (i) => (i % 2 === 0 ? "record" : "tx"));
    expect(bytes(b.state.rows)).toBe(bytes(a.state.rows));
    expect(bytes(c.state.rows)).toBe(bytes(a.state.rows));
  });

  it("every appended row verifies under its predecessor", async () => {
    const { returned } = await viaInTx(CHAIN_PARAMS, () => "tx");
    let prev = "";
    for (const r of returned) {
      expect(r.prevSignatureHash).toBe(prev === "" ? "" : hashSignature(prev));
      expect(
        signer.verify(
          {
            at: r.at,
            severity: r.severity,
            sourceIcon: r.sourceIcon,
            what: r.what,
            sub: r.sub,
            kind: r.kind,
            refs: r.refs,
            actorType: r.actorType,
            actorId: r.actorId,
            schemaVersion: r.schemaVersion,
          },
          r.prevSignatureHash,
          r.signature,
        ),
      ).toBe(true);
      prev = r.signature;
    }
  });

  it("takes the chain lock before reading the tail, inside the CALLER's transaction", async () => {
    const state = makePrismaFake();
    await appendActivityRowInTx(state.tx as never, signer, CHAIN_PARAMS[0]!);
    expect(state.queries[0]).toContain("pg_advisory_xact_lock(hashtext('droplet:activity-chain-append'))");
    expect(state.queries[1]).toContain('SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1');
    // It never opens a transaction of its own — the caller owns the boundary.
    expect(state.transactionCount.count).toBe(0);
  });

  it("validates before touching the transaction (same guards as record())", async () => {
    const state = makePrismaFake();
    await expect(
      appendActivityRowInTx(state.tx as never, signer, {
        kind: "system",
        severity: "info",
        sourceIcon: "shield",
        what: "x",
        actor: { type: "user", id: "" },
      }),
    ).rejects.toThrow(/requires a non-empty id/);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
    expect(() =>
      // @ts-expect-error — testing runtime guard
      validateRecordParams({ kind: "system", severity: "loud", sourceIcon: "x", what: "x", actor: { type: "system" } }),
    ).toThrow(/unknown ActivitySeverity/);
  });

  it("record() validates BEFORE opening a transaction, so a bad call never takes the chain lock", async () => {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    await expect(
      // @ts-expect-error — testing runtime guard
      rec.record({ kind: "nope", severity: "info", sourceIcon: "x", what: "x", actor: { type: "system" } }),
    ).rejects.toThrow(/unknown ActivityKind/);
    expect(state.transactionCount.count).toBe(0);
    expect(state.queries).toEqual([]);
  });
});

// ── WARP-2977 P2b: equivalence to the PRE-SPLIT recorder, not to itself ──
//
// The byte-identical tests above compare record() with appendActivityRowInTx,
// which share one body — they would stay green for any regression in it. These
// literals were computed by running the pre-split recorder (61fa4aebe,
// `createActivityRecorder` before the S0 extraction) over this exact fake,
// key and CHAIN_PARAMS. A change to what is signed, chained or stored turns
// them red.
//
// WARP-3011 moved the write from `activityRow.create` to a raw INSERT, so the
// stored-content digest is now taken over the INSERT's parameters, with keys
// sorted (see `storedContentDigest`). Its literal was computed by running the
// last recorder that wrote through `activityRow.create` (c2e3051a5, whose
// create data the previous, order-sensitive literal pinned to 61fa4aebe) over
// this fake, key and params, through the same function.
const GOLDEN_PRE_SPLIT = {
  rows: [
    { signature: "644RP3vUWFbTjHvlQ9bWM-qzMcPtPpnTbC0VMBoMuIQ", prevSignatureHash: "" },
    { signature: "3Dxukv2PY-9MBi86d4rlDjiHNzOi0WdfaqnI6lvzSBE", prevSignatureHash: "tM7Nh7D9SzKV96cCot_NDHQkX7RMVT9RJlmiWraOYPQ" },
    { signature: "dT4seqQmyZ_jOwfMAzC23xmouQtjL9iGFxoJKy_jr3U", prevSignatureHash: "DrLyIWYJEzDYSILSajKYGk1rl7mFHS6NlTX-x-D8P4A" },
    { signature: "os5wrrfYVx1gUNeeEuYdal6Pb4kzO54nULUqiFXCA5Q", prevSignatureHash: "e2xLFTds-bt56isichSM4tHpXrcbNv70TNKgpv9WN50" },
  ],
  /** `storedContentDigest` of every row, in order. */
  storedContentSha256: "6bca59c226b1408f3a1ea3164b24d0e2859ddf7592aa12c9b9d8bcfacbbee7c9",
} as const;

// ── Type-correct params that are NOT plain literals (WARP-2977 P2b) ──
//
// 61fa4aebe read `params.what`, `params.actor.type`, `params.actor.id` … by
// name, so prototype getters, inherited and non-enumerable properties all
// counted. A `{...spread}` snapshot saw none of them: the getter actor threw
// 'unknown ActivityActorType', the non-enumerable ai id was stored NULL. The
// literals below were computed by running 61fa4aebe's recorder over this exact
// fake and key (the stored-content digest as GOLDEN_PRE_SPLIT's, WARP-3011).
const EXOTIC_IDS = {
  getter: "33333333-3333-4333-8333-333333333333",
  hiddenAi: "44444444-4444-4444-8444-444444444444",
  hiddenUser: "55555555-5555-4555-8555-555555555555",
  readOnce: "66666666-6666-4666-8666-666666666666",
} as const;

class GetterActor implements ActivityActor {
  get type(): "ai" {
    return "ai";
  }
  get id(): string {
    return EXOTIC_IDS.getter;
  }
}

class GetterWhatParams implements RecordParams {
  kind = "system" as const;
  severity = "info" as const;
  sourceIcon = "info";
  actor: ActivityActor = { type: "system" };
  at: Date;
  constructor(at: Date) {
    this.at = at;
  }
  get what(): string {
    return "from a getter";
  }
}

function hiddenId(type: "ai" | "user", id: string): ActivityActor {
  const actor = { type } as ActivityActor;
  Object.defineProperty(actor, "id", { value: id, enumerable: false });
  return actor;
}

/** An `id` getter that answers once: 61fa4aebe read it once, for the check and the row. */
function readOnceUser(id: string): ActivityActor {
  let reads = 0;
  return {
    type: "user",
    get id() {
      return reads++ === 0 ? id : "";
    },
  };
}

/** Fresh objects per call — `readOnceUser` is stateful. */
const EXOTIC_PARAMS = (): RecordParams[] => [
  { kind: "tool_call", severity: "ok", sourceIcon: "wrench", what: "getter actor", actor: new GetterActor(), at: new Date(P1.getTime() + 10_000) },
  { kind: "tool_call", severity: "ok", sourceIcon: "wrench", what: "non-enumerable ai id", actor: hiddenId("ai", EXOTIC_IDS.hiddenAi), at: new Date(P1.getTime() + 11_000) },
  { kind: "auth", severity: "ok", sourceIcon: "log-in", what: "non-enumerable user id", sub: "from lan", actor: hiddenId("user", EXOTIC_IDS.hiddenUser), at: new Date(P1.getTime() + 12_000) },
  { kind: "system", severity: "info", sourceIcon: "info", what: "inherited actor type", refs: { k: "v" }, actor: Object.create({ type: "system" }) as ActivityActor, at: new Date(P1.getTime() + 13_000) },
  new GetterWhatParams(new Date(P1.getTime() + 14_000)),
  { kind: "system", severity: "info", sourceIcon: "shield", what: "an id getter, read once", actor: readOnceUser(EXOTIC_IDS.readOnce), at: new Date(P1.getTime() + 15_000) },
];

const GOLDEN_EXOTIC = {
  rows: [
    { signature: "4gdFAiDMiShIP5aTjp9kFoDIICLKiW0eqZ-tX-9ol5s", prevSignatureHash: "" },
    { signature: "K-7loaC3fuZEQe3wbmTB_us7R7KuTmAayz8ZMr-T0-I", prevSignatureHash: "cxZF9A4w1mTG1czW8cdGBypG3irwYaDA-UGmMaO3Fno" },
    { signature: "Y8yHynEyHg-FH0KSz2FNARqOKKtwj07mUO4BnMI7cMs", prevSignatureHash: "dMPiR2cGHOWFW5C_v5XgUubyM9qhvL5gBjb1sDGQlGo" },
    { signature: "l0SBnrzK8af9EMzhnnNS0Jczg1ttwWIdEseIRKb1Dfo", prevSignatureHash: "PlhVtstkg4M0DGQBO9zF_NMDUr26mNlmdfns6iN4RrQ" },
    { signature: "G-gADKv7fFCs0Tp7oZlQbRFMDCn3UtkWkB1GhcKQqsw", prevSignatureHash: "0WLuFdT2uML_iuEVbIiU9a4Ys0sedv_khLQPg3Phhso" },
    { signature: "V7HROoDPS-4RQnyp6n0ezuzTNeT7hBMYY0k_kVPTk4Y", prevSignatureHash: "-crNSVYl1K1pSL-Qhd5vGlPAxf8PqnMX531VOW-mdp8" },
  ],
  /** `storedContentDigest` of every row, in order. */
  storedContentSha256: "6865b20f8d796a60ca80b575029d450c0cf1a115db4ca3b6aece5c70dae61ed5",
} as const;

/** The INSERT's columns, in parameter order (`INSERT_ACTIVITY_ROW_SQL`). */
const INSERT_COLUMNS = [
  "at",
  "severity",
  "sourceIcon",
  "what",
  "sub",
  "kind",
  "refs",
  "signature",
  "prevSignatureHash",
  "actorType",
  "actorId",
  "schemaVersion",
] as const;

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeysDeep(o[k])]));
  }
  return v;
}

/**
 * sha256 of what every row stores, in order: each INSERT's twelve columns as
 * one object — `at` the bound ISO text, refs parsed from the bound text, null
 * when absent — with the keys of every object sorted. Sorted because
 * `ActivityRow.refs` is jsonb, which keeps no key order: neither Prisma's
 * Json write nor the raw INSERT could store one, so the same literal pins
 * both (the pre-WARP-3011 literal was taken over `activityRow.create` data
 * mapped through `JSON.parse(JSON.stringify(…))` to the same shape).
 */
function storedContentDigest(insertParams: unknown[][]): string {
  const rows = insertParams.map((params) => {
    const row: Record<string, unknown> = Object.fromEntries(INSERT_COLUMNS.map((c, i) => [c, params[i]]));
    row.refs = params[REFS_PARAM] === null ? null : JSON.parse(params[REFS_PARAM] as string);
    return row;
  });
  return createHash("sha256").update(JSON.stringify(sortKeysDeep(rows))).digest("hex");
}

function contentOf(r: Awaited<ReturnType<ActivityRowRecorder["record"]>>) {
  return {
    at: r.at,
    severity: r.severity,
    sourceIcon: r.sourceIcon,
    what: r.what,
    sub: r.sub,
    kind: r.kind,
    refs: r.refs,
    actorType: r.actorType,
    actorId: r.actorId,
    schemaVersion: r.schemaVersion,
  };
}

describe("record() matches the pre-split recorder (golden, WARP-2977 P2b)", () => {
  const signer = createHmacSigner(KEY);

  it("record() writes exactly what 61fa4aebe's recorder wrote", async () => {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    const out = [];
    for (const p of CHAIN_PARAMS) out.push(await rec.record(p));
    expect(out.map((r) => ({ signature: r.signature, prevSignatureHash: r.prevSignatureHash }))).toEqual(
      GOLDEN_PRE_SPLIT.rows,
    );
    expect(storedContentDigest(state.insertParams)).toBe(GOLDEN_PRE_SPLIT.storedContentSha256);
  });

  it("an in-transaction append writes exactly the same rows", async () => {
    const state = makePrismaFake();
    const out = [];
    for (const p of CHAIN_PARAMS) {
      out.push(await state.prisma.$transaction((tx) => appendActivityRowInTx(tx as never, signer, p)));
    }
    expect(out.map((r) => ({ signature: r.signature, prevSignatureHash: r.prevSignatureHash }))).toEqual(
      GOLDEN_PRE_SPLIT.rows,
    );
    expect(storedContentDigest(state.insertParams)).toBe(GOLDEN_PRE_SPLIT.storedContentSha256);
  });

  it("the default `at` is the CALL time, not the time the transaction began", async () => {
    // Prisma checks out a pooled connection and sends BEGIN before the
    // callback runs — up to maxWait (2 s) under load. The pre-split recorder
    // stamped `at` before that; so must this one.
    vi.useFakeTimers();
    try {
      const T0 = new Date("2026-09-24T10:00:00.000Z");
      vi.setSystemTime(T0);
      const state = makePrismaFake({ beginDelayMs: 1_500 });
      const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
      const pending = rec.record({ kind: "system", severity: "info", sourceIcon: "info", what: "Boot", actor: { type: "system" } });
      await vi.advanceTimersByTimeAsync(1_500);
      const row = await pending;
      // Not vacuous: the clock really moved while BEGIN was pending.
      expect(Date.now()).toBe(T0.getTime() + 1_500);
      expect(row.at.toISOString()).toBe(T0.toISOString());
      expect(state.rows[0]!.at.toISOString()).toBe(T0.toISOString());
      expect(signer.verify(contentOf(row), "", row.signature)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller reassigning a param after the call cannot split the signed row from the stored one", async () => {
    const state = makePrismaFake({ beginDelayMs: 5 });
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    const USER = "11111111-1111-4111-8111-111111111111";
    const params: RecordParams = { kind: "system", severity: "info", sourceIcon: "info", what: "original", actor: { type: "user", id: USER } };
    const pending = rec.record(params);
    params.what = "mutated after the call";
    params.sub = "mutated too";
    // The actor object too: 61fa4aebe read actor.type/actor.id at call time,
    // so it stored the originals and never threw.
    params.actor.id = "mutated-user";
    (params.actor as { type: string }).type = "robot";
    const row = await pending;
    expect(row.what).toBe("original");
    expect(row.sub).toBeNull();
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe(USER);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.actorType).toBe("user");
    expect(state.rows[0]!.actorId).toBe(USER);
    expect(signer.verify(contentOf(row), "", row.signature)).toBe(true);
  });

  it("record() reads every param BY NAME, as 61fa4aebe did — getters, inherited and non-enumerable fields (golden)", async () => {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
    const out = [];
    for (const p of EXOTIC_PARAMS()) out.push(await rec.record(p));
    expect(out.map((r) => ({ signature: r.signature, prevSignatureHash: r.prevSignatureHash }))).toEqual(GOLDEN_EXOTIC.rows);
    expect(storedContentDigest(state.insertParams)).toBe(GOLDEN_EXOTIC.storedContentSha256);
    // Not vacuous — the attribution a spread lost:
    expect(out.map((r) => [r.what, r.actorType, r.actorId])).toEqual([
      ["getter actor", "ai", EXOTIC_IDS.getter],
      ["non-enumerable ai id", "ai", EXOTIC_IDS.hiddenAi],
      ["non-enumerable user id", "user", EXOTIC_IDS.hiddenUser],
      ["inherited actor type", "system", null],
      ["from a getter", "system", null],
      ["an id getter, read once", "user", EXOTIC_IDS.readOnce],
    ]);
    for (const r of out) expect(signer.verify(contentOf(r), r.prevSignatureHash, r.signature)).toBe(true);
  });

  it("an in-tx append reads them the same way, and validates exactly what it stores (golden)", async () => {
    const state = makePrismaFake();
    const out = [];
    for (const p of EXOTIC_PARAMS()) {
      out.push(await state.prisma.$transaction((tx) => appendActivityRowInTx(tx as never, signer, p)));
    }
    expect(out.map((r) => ({ signature: r.signature, prevSignatureHash: r.prevSignatureHash }))).toEqual(GOLDEN_EXOTIC.rows);
    expect(storedContentDigest(state.insertParams)).toBe(GOLDEN_EXOTIC.storedContentSha256);
    // The read-once id getter: validated and stored from ONE read. Validating
    // the original and then copying would store the second read ("") — a
    // user row with no id that validation never saw.
    expect(state.rows[5]!.actorId).toBe(EXOTIC_IDS.readOnce);
  });

  it("the snapshot is a plain copy of every RecordParams field, missing actor kept missing", () => {
    const at = new Date(P1.getTime() + 20_000);
    const snap = snapshotRecordParams(new GetterWhatParams(at), new Date(0));
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(snap).toEqual({ kind: "system", severity: "info", sourceIcon: "info", what: "from a getter", sub: undefined, refs: undefined, actor: { type: "system", id: undefined }, at });
    expect(Object.keys(snap).sort()).toEqual(["actor", "at", "kind", "refs", "severity", "sourceIcon", "sub", "what"]);
    const d = new Date(1);
    expect(snapshotRecordParams({ ...CHAIN_PARAMS[1]!, at: undefined }, d).at).toBe(d);
    // No actor → validation reports it exactly as the pre-split recorder did.
    const noActor = snapshotRecordParams({ kind: "system", severity: "info", sourceIcon: "x", what: "x" } as unknown as RecordParams, d);
    expect(noActor.actor).toBeUndefined();
    expect(() => validateRecordParams(noActor)).toThrow("unknown ActivityActorType: undefined");
  });

  it("an in-tx append snapshots its params too — it may wait behind another append on the handle", async () => {
    const state = makePrismaFake();
    const USER = "11111111-1111-4111-8111-111111111111";
    const first = appendActivityRowInTx(state.tx as never, signer, CHAIN_PARAMS[0]!);
    const params: RecordParams = { kind: "system", severity: "info", sourceIcon: "info", what: "original", actor: { type: "user", id: USER } };
    const second = appendActivityRowInTx(state.tx as never, signer, params);
    params.what = "mutated while queued";
    params.actor.id = "mutated-user";
    (params.actor as { type: string }).type = "robot";
    await first;
    const row = await second;
    expect([row.what, row.actorType, row.actorId]).toEqual(["original", "user", USER]);
    expect(signer.verify(contentOf(row), row.prevSignatureHash, row.signature)).toBe(true);
  });
});

describe("appendActivityRowInTx preconditions (WARP-2977 P2b)", () => {
  const signer = createHmacSigner(KEY);

  it("refuses a bare client (it has $transaction) before issuing any statement", async () => {
    const state = makePrismaFake();
    const p = appendActivityRowInTx(state.prisma as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    await expect(p).rejects.toThrow(/not the bare Prisma client/);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it.each([["repeatable read"], ["serializable"], [null]])(
    "refuses a transaction whose isolation is %s — after the lock round-trip, writing nothing",
    async (iso) => {
      const state = makePrismaFake({ iso });
      const p = state.prisma.$transaction((tx) => appendActivityRowInTx(tx as never, signer, CHAIN_PARAMS[0]!));
      await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
      await expect(p).rejects.toThrow(/READ COMMITTED/);
      // The lock statement only: no tail read, no insert.
      expect(state.queries).toHaveLength(1);
      expect(state.rows).toEqual([]);
    },
  );

  it.each([["repeatable read"], ["serializable"]])(
    "record() STATES READ COMMITTED, so a client / database default of %s still writes (61fa4aebe always wrote)",
    async (iso) => {
      const state = makePrismaFake({ iso });
      const rec = createActivityRecorder({ prisma: state.prisma as never, signer });
      const row = await rec.record(CHAIN_PARAMS[0]!);
      expect(state.transactionOptions()).toEqual([READ_COMMITTED_TX]);
      expect(state.rows).toHaveLength(1);
      expect(bytes(row)).toBe(bytes(await viaRecordOnce(signer, CHAIN_PARAMS[0]!)));
      // The fake is honest about the default: without the stated level the
      // same transaction would have been refused.
      await expect(
        state.prisma.$transaction((tx) => appendActivityRowInTx(tx as never, signer, CHAIN_PARAMS[1]!)),
      ).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    },
  );

  it("reads the isolation level and the transaction start in the SAME statements as the lock and the tail (no extra round-trip)", async () => {
    const state = makePrismaFake();
    await createActivityRecorder({ prisma: state.prisma as never, signer }).record(CHAIN_PARAMS[0]!);
    // Lock, tail read, INSERT (WARP-3011) — no statement for the checks.
    expect(state.queries).toHaveLength(3);
    expect(state.queries[0]).toBe(
      "SELECT (pg_advisory_xact_lock(hashtext('droplet:activity-chain-append')) IS NULL) AS locked, current_setting('transaction_isolation') AS iso, transaction_timestamp()::text AS txts",
    );
    expect(state.queries[1]).toBe(
      'SELECT transaction_timestamp()::text AS txts, (SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1) AS signature',
    );
    expect(statementKind(state.queries[2]!)).toBe("insert");
  });

  it("refuses the bare client's methods on an object without $transaction — no transaction id — before any statement", async () => {
    // The shape an earlier review forked the chain with: it type-checks,
    // passes the shape check and reports 'read committed' while every
    // statement autocommits. It carries no transaction id.
    const state = makePrismaFake({ autocommit: true });
    const handle = { $queryRawUnsafe: state.prisma.$queryRawUnsafe, activityRow: state.prisma.activityRow };
    const p = appendActivityRowInTx(handle as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    await expect(p).rejects.toThrow(/transaction id/);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it("second layer: a handle that carries an id but whose statements autocommit is refused after the tail read, writing nothing", async () => {
    // Only a forged id gets here; transaction_timestamp() still catches it.
    const state = makePrismaFake({ autocommit: true });
    const p = appendActivityRowInTx(state.tx as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    await expect(p).rejects.toThrow(/different transactions/);
    // Lock and tail read only: no insert.
    expect(state.queries).toHaveLength(2);
    expect(state.rows).toEqual([]);
  });

  it.each([
    ["a wrapper built around the real tx", (tx: FakeTx) => ({ $queryRawUnsafe: tx.$queryRawUnsafe, activityRow: tx.activityRow })],
    ["an empty transaction id", (tx: FakeTx) => ({ ...tx, [TX_ID]: "" })],
    ["a numeric transaction id", (tx: FakeTx) => ({ ...tx, [TX_ID]: 1 })],
    ["an object transaction id", (tx: FakeTx) => ({ ...tx, [TX_ID]: { id: "fake-tx" } })],
    ["a null transaction id", (tx: FakeTx) => ({ ...tx, [TX_ID]: null })],
  ])("refuses %s before any statement, writing nothing", async (_name, build) => {
    const state = makePrismaFake();
    const p = appendActivityRowInTx(build(state.tx) as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    await expect(p).rejects.toThrow(/transaction id/);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  // s0-rereview-3: a COPY of the real tx. Prisma's handle keeps its methods
  // off its own enumerable keys, so a spread copies the transaction-id symbol
  // (and passes the id check) but not `$queryRawUnsafe` / `activityRow`. The
  // first statement then threw a TypeError, which auditSecurityInTx wrapped
  // as AUDIT_UNAVAILABLE — an outage (503) instead of the programming error.
  /** A handle shaped like Prisma's: methods inherited, only the id symbol its own. */
  function prismaShapedTx(state: ReturnType<typeof makePrismaFake>): FakeTx {
    const inner = state.makeTx();
    const handle = Object.create({ $queryRawUnsafe: inner.$queryRawUnsafe, activityRow: inner.activityRow }) as FakeTx;
    Object.defineProperty(handle, TX_ID, { value: inner[TX_ID], enumerable: true });
    return handle;
  }

  it("a Prisma-shaped handle (methods inherited, not own) appends", async () => {
    const state = makePrismaFake();
    await appendActivityRowInTx(prismaShapedTx(state) as never, signer, CHAIN_PARAMS[0]!);
    expect(state.rows).toHaveLength(1);
  });

  const COPIES: Array<[string, (tx: FakeTx) => unknown]> = [
    ["{...tx}", (tx) => ({ ...tx })],
    ["Object.assign({}, tx)", (tx) => Object.assign({}, tx)],
    ["{...tx, requestId}", (tx) => ({ ...tx, requestId: "req-1" })],
  ];

  it.each(COPIES)("refuses a copy of the tx, %s — it keeps the id, not the methods — before any statement", async (_n, copy) => {
    const state = makePrismaFake();
    const handle = copy(prismaShapedTx(state)) as Record<symbol, unknown>;
    expect(typeof handle[TX_ID]).toBe("string");
    const p = appendActivityRowInTx(handle as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    await expect(p).rejects.toThrow(/transaction client itself/);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it.each([
    ["$queryRawUnsafe missing", (tx: FakeTx) => ({ ...tx, $queryRawUnsafe: undefined })],
    ["$queryRawUnsafe not a function", (tx: FakeTx) => ({ ...tx, $queryRawUnsafe: "SELECT 1" })],
    ["activityRow missing", (tx: FakeTx) => ({ ...tx, activityRow: undefined })],
    ["activityRow null", (tx: FakeTx) => ({ ...tx, activityRow: null })],
    ["activityRow.create not a function", (tx: FakeTx) => ({ ...tx, activityRow: { create: 1 } })],
  ])("refuses a handle with an id but %s, before any statement", async (_n, build) => {
    const state = makePrismaFake();
    const p = appendActivityRowInTx(build(state.makeTx()) as never, signer, CHAIN_PARAMS[0]!);
    await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it.each(COPIES)("through auditSecurityInTx, a copy (%s) is the programming error (500), never AUDIT_UNAVAILABLE (503)", async (_n, copy) => {
    const state = makePrismaFake();
    _setActivityRecorderForTests(createActivityRecorder({ prisma: state.prisma as never, signer }), signer);
    try {
      const p = auditSecurityInTx(copy(prismaShapedTx(state)) as never, { user: { id: "u-1", role: "owner" } }, {
        action: "zone.update",
        what: "Security: changed an area",
      });
      await expect(p).rejects.toBeInstanceOf(ActivityChainPreconditionError);
      await expect(p).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
      expect(state.queries).toEqual([]);
      expect(state.rows).toEqual([]);
    } finally {
      _setActivityRecorderForTests(null, null);
    }
  });

  it("every $transaction hands its callback a fresh handle with its own id (the fake mirrors Prisma)", async () => {
    const state = makePrismaFake();
    const ids = await Promise.all([1, 2, 3].map(() => state.prisma.$transaction(async (tx) => tx[TX_ID])));
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect((state.prisma as unknown as Record<symbol, unknown>)[TX_ID]).toBeUndefined();
  });

  it.each([
    ["no txts from either statement", [{ locked: true, iso: "read committed" }], [{ signature: null }]],
    ["no txts from the lock", [{ locked: true, iso: "read committed" }], [{ txts: FAKE_TXTS, signature: null }]],
    ["no txts from the tail read", [{ locked: true, iso: "read committed", txts: FAKE_TXTS }], [{ signature: null }]],
    ["an empty tail result", [{ locked: true, iso: "read committed", txts: FAKE_TXTS }], []],
    ["an empty txts on both", [{ locked: true, iso: "read committed", txts: "" }], [{ txts: "", signature: null }]],
  ])("fails closed on %s", async (_name, lockResult, tailResult) => {
    const state = makePrismaFake();
    const results = [lockResult, tailResult];
    const handle = { ...state.makeTx(), $queryRawUnsafe: async () => results.shift() };
    await expect(appendActivityRowInTx(handle as never, signer, CHAIN_PARAMS[0]!)).rejects.toBeInstanceOf(
      ActivityChainPreconditionError,
    );
    // Both statements ran — it is the timestamp check that refused, not the id check.
    expect(results).toEqual([]);
    expect(state.rows).toEqual([]);
  });
});

describe("appendActivityRowInTx — concurrent appends on ONE handle (WARP-2977 P2b)", () => {
  // pg_advisory_xact_lock is re-entrant within one backend, so two appends
  // running concurrently on the same transaction both "hold" it, read the same
  // tail and fork the chain. The append serialises them in-process instead.
  const signer = createHmacSigner(KEY);
  const sys = (what: string): RecordParams => ({ kind: "system", severity: "info", sourceIcon: "shield", what, actor: { type: "system" } });

  function linear(rows: Array<{ signature: string; prevSignatureHash: string }>): void {
    expect(rows[0]!.prevSignatureHash).toBe("");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevSignatureHash).toBe(hashSignature(rows[i - 1]!.signature));
    }
  }

  it("Promise.all of three appends on one tx chains linearly, in call order", async () => {
    const state = makePrismaFake();
    await state.prisma.$transaction((tx) =>
      Promise.all([
        appendActivityRowInTx(tx as never, signer, sys("p1")),
        appendActivityRowInTx(tx as never, signer, sys("p2")),
        appendActivityRowInTx(tx as never, signer, sys("p3")),
      ]),
    );
    expect(state.rows.map((r) => r.what)).toEqual(["p1", "p2", "p3"]);
    linear(state.rows);
    // Each append ran lock → tail → insert before the next took the lock.
    expect(state.queries.map(statementKind)).toEqual([
      "lock",
      "tail",
      "insert",
      "lock",
      "tail",
      "insert",
      "lock",
      "tail",
      "insert",
    ]);
  });

  it("a rejected append does not wedge the next one on the handle", async () => {
    const state = makePrismaFake();
    const failing: ActivityRowSigner = {
      ...signer,
      sign() {
        throw new Error("signer down");
      },
    };
    const settled = await Promise.allSettled([
      appendActivityRowInTx(state.tx as never, signer, sys("p1")),
      appendActivityRowInTx(state.tx as never, failing, sys("p2")),
      appendActivityRowInTx(state.tx as never, signer, sys("p3")),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((settled[1] as PromiseRejectedResult).reason).toEqual(new Error("signer down"));
    expect(state.rows.map((r) => r.what)).toEqual(["p1", "p3"]);
    linear(state.rows);
  });

  it("the queue is per transaction: an append stuck on one transaction does not hold up another's", async () => {
    const stuck = makePrismaFake();
    const stuckHandle = { ...stuck.tx, $queryRawUnsafe: () => new Promise<never>(() => {}) };
    void appendActivityRowInTx(stuckHandle as never, signer, sys("waits on the chain lock forever"));
    const other = makePrismaFake();
    const row = await appendActivityRowInTx(other.tx as never, signer, sys("another transaction"));
    expect(row.what).toBe("another transaction");
    expect(stuck.rows).toEqual([]);
    // …and on the same table, a second transaction is not held up either.
    const sameTable = await appendActivityRowInTx(stuck.makeTx() as never, signer, sys("same table, another transaction"));
    expect(sameTable.what).toBe("same table, another transaction");
  });

  it("the queue is keyed on the TRANSACTION, not the handle object: fresh handles carrying one transaction's id chain linearly", async () => {
    // Three distinct objects on one transaction, each forwarding its id.
    // Keyed by object, each would get a queue of its own and fork the chain.
    const state = makePrismaFake();
    const forwarding = (tx: FakeTx) => ({ $queryRawUnsafe: tx.$queryRawUnsafe, activityRow: tx.activityRow, [TX_ID]: tx[TX_ID] });
    await state.prisma.$transaction((tx) =>
      Promise.all([
        appendActivityRowInTx(forwarding(tx) as never, signer, sys("p1")),
        appendActivityRowInTx(forwarding(tx) as never, signer, sys("p2")),
        appendActivityRowInTx(forwarding(tx) as never, signer, sys("p3")),
      ]),
    );
    expect(state.rows.map((r) => r.what)).toEqual(["p1", "p2", "p3"]);
    linear(state.rows);
    expect(state.queries.map(statementKind)).toEqual([
      "lock",
      "tail",
      "insert",
      "lock",
      "tail",
      "insert",
      "lock",
      "tail",
      "insert",
    ]);
  });

  it("Promise.all over fresh wrappers WITHOUT the id is refused whole — nothing written, nothing forked", async () => {
    const state = makePrismaFake();
    const attempt = state.prisma.$transaction((tx) =>
      Promise.all(
        [1, 2, 3].map((i) =>
          appendActivityRowInTx({ $queryRawUnsafe: tx.$queryRawUnsafe, activityRow: tx.activityRow } as never, signer, sys(`w${i}`)),
        ),
      ),
    );
    await expect(attempt).rejects.toBeInstanceOf(ActivityChainPreconditionError);
    expect(state.queries).toEqual([]);
    expect(state.rows).toEqual([]);
  });
});

describe("appendActivityRowInTx — the compile-time guard (WARP-2977 P2b)", () => {
  const signer = createHmacSigner(KEY);

  it("a bare PrismaClient is a compile error as an append handle; a transaction client is not", () => {
    // Type-level pin: tsc typechecks this file. Dropping `$transaction?: never`
    // from ActivityAppendTx makes the @ts-expect-error lines unused → red.
    const typeOnly = (client: PrismaClient, tx: Prisma.TransactionClient) => {
      // @ts-expect-error — a bare client autocommits; its advisory lock serialises nothing
      void appendActivityRowInTx(client, signer, CHAIN_PARAMS[0]!);
      // @ts-expect-error — same guard through the singleton
      void recordActivityInTx(client, CHAIN_PARAMS[0]!);
      void appendActivityRowInTx(tx, signer, CHAIN_PARAMS[0]!);
      void recordActivityInTx(tx, CHAIN_PARAMS[0]!);
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("recordActivityInTx — refuses to commit an unaudited change (WARP-2977 P2b)", () => {
  afterEach(() => _setActivityRecorderForTests(null, null));

  it("throws when the recorder has not been initialised", async () => {
    _setActivityRecorderForTests(null, null);
    const state = makePrismaFake();
    await expect(recordActivityInTx(state.tx as never, CHAIN_PARAMS[0]!)).rejects.toThrow(/not initialised/);
    expect(state.queries).toEqual([]);
  });

  it("throws when only the signer is missing", async () => {
    const state = makePrismaFake();
    const rec = createActivityRecorder({ prisma: state.prisma as never, signer: createHmacSigner(KEY) });
    _setActivityRecorderForTests(rec, null);
    await expect(recordActivityInTx(state.tx as never, CHAIN_PARAMS[0]!)).rejects.toThrow(/not initialised/);
  });

  it("appends through the caller's handle with the bound signer", async () => {
    const signer = createHmacSigner(KEY);
    const state = makePrismaFake();
    _setActivityRecorderForTests(createActivityRecorder({ prisma: state.prisma as never, signer }), signer);
    const row = await recordActivityInTx(state.tx as never, CHAIN_PARAMS[0]!);
    expect(state.rows).toHaveLength(1);
    expect(state.transactionCount.count).toBe(0);
    const expected = await viaRecordOnce(signer, CHAIN_PARAMS[0]!);
    expect(bytes(row)).toBe(bytes(expected));
  });

  it("propagates an append failure (the caller's transaction rolls back)", async () => {
    const signer = createHmacSigner(KEY);
    const state = makePrismaFake({
      insertResult: () => {
        throw new Error("disk full");
      },
    });
    _setActivityRecorderForTests(createActivityRecorder({ prisma: state.prisma as never, signer }), signer);
    await expect(recordActivityInTx(state.tx as never, CHAIN_PARAMS[0]!)).rejects.toThrow("disk full");
    // It was the INSERT that failed: the lock and the tail read ran first.
    expect(state.queries.map(statementKind)).toEqual(["lock", "tail", "insert"]);
    expect(state.rows).toEqual([]);
  });
});

async function viaRecordOnce(signer: ActivityRowSigner, p: RecordParams) {
  const state = makePrismaFake();
  return createActivityRecorder({ prisma: state.prisma as never, signer }).record(p);
}

describe("actorFromRequest (WARP-181)", () => {
  it("maps an authenticated human to a user actor with the canonical UUID", () => {
    expect(
      actorFromRequest({ user: { id: "uuid-alice", role: "owner" } }),
    ).toEqual({ type: "user", id: "uuid-alice" });
  });

  it("maps a service principal to system with a null id (never a user actor)", () => {
    // AC1: actorId is a canonical user UUID — "_service:*" principal
    // strings must never land there under type user. `ai` stays
    // reserved for agent-loop-driven actions, so principals map to
    // system; the principal string belongs in refs at the call site.
    expect(
      actorFromRequest({ user: { id: "_service:voice", role: "service" } }),
    ).toEqual({ type: "system", id: null });
    // Defense-in-depth: the id prefix alone is enough even if the
    // role claim is missing.
    expect(actorFromRequest({ user: { id: "_service:mcp" } })).toEqual({
      type: "system",
      id: null,
    });
  });

  it("maps an unauthenticated request to anonymous", () => {
    expect(actorFromRequest({})).toEqual({ type: "anonymous" });
    expect(actorFromRequest({ user: undefined })).toEqual({
      type: "anonymous",
    });
  });
});
