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
import { describe, it, expect, beforeEach } from "vitest";
import {
  actorFromRequest,
  createActivityRecorder,
  type ActivityRowRecorder,
} from "./activity.service.js";
import {
  canonicalizeRowContent,
  canonicalRefsJson,
  createHmacSigner,
  hashSignature,
  type ActivityRowSigner,
} from "./audit-signing.service.js";
import {
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

interface FakePrisma {
  $queryRawUnsafe: <T>(query: string, ...params: unknown[]) => Promise<T>;
  $transaction: <T>(
    fn: (tx: FakePrisma) => Promise<T>,
  ) => Promise<T>;
}

function makePrismaFake(): {
  prisma: FakePrisma;
  rows: FakeActivityRow[];
  transactionCount: { count: number };
  queries: string[];
  insertParams: unknown[][];
} {
  const rows: FakeActivityRow[] = [];
  const transactionCount = { count: 0 };
  const queries: string[] = [];
  const insertParams: unknown[][] = [];
  let nextId = 1n;

  const prisma: FakePrisma = {
    async $queryRawUnsafe<T>(query: string, ...params: unknown[]) {
      queries.push(query);
      // WARP-3011: the append's INSERT. Keep exactly what the recorder bound
      // — the refs cases below assert on the parameter itself.
      if (isActivityRowInsert(query)) {
        insertParams.push(params);
        const row = activityRowFromInsert(nextId++, params) as FakeActivityRow;
        rows.push(row);
        return [{ id: row.id }] as unknown as T;
      }
      // WARP-1026: first call per record() is the chain-append advisory
      // lock; its result is ignored by the recorder.
      if (query.includes("pg_advisory_xact_lock")) {
        return [{ locked: true }] as unknown as T;
      }
      // Tail read: most recent row's signature, id desc.
      if (rows.length === 0) return [] as unknown as T;
      return [{ signature: rows[rows.length - 1]!.signature }] as unknown as T;
    },
    async $transaction(fn) {
      transactionCount.count++;
      return fn(prisma);
    },
  };
  return { prisma, rows, transactionCount, queries, insertParams };
}

/** The INSERT binds `refs` as its 7th parameter (`$7::jsonb`). */
const REFS_PARAM = 6;

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
    const prisma = makePrismaFake().prisma;
    const inner = prisma.$queryRawUnsafe.bind(prisma);
    prisma.$queryRawUnsafe = async <T>(query: string, ...params: unknown[]) =>
      (isActivityRowInsert(query) ? [] : await inner(query, ...params)) as T;
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
