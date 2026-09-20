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
import { Prisma } from "@prisma/client";
import {
  actorFromRequest,
  createActivityRecorder,
  type ActivityRowRecorder,
} from "./activity.service.js";
import {
  createHmacSigner,
  hashSignature,
  type ActivityRowSigner,
} from "./audit-signing.service.js";

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
  activityRow: {
    create: (args: { data: Record<string, unknown> }) => Promise<FakeActivityRow>;
  };
  $queryRawUnsafe: <T>(query: string) => Promise<T>;
  $transaction: <T>(
    fn: (tx: FakePrisma) => Promise<T>,
  ) => Promise<T>;
}

function makePrismaFake(): {
  prisma: FakePrisma;
  rows: FakeActivityRow[];
  transactionCount: { count: number };
  queries: string[];
  rawRefs: unknown[];
} {
  const rows: FakeActivityRow[] = [];
  const transactionCount = { count: 0 };
  const queries: string[] = [];
  const rawRefs: unknown[] = [];
  let nextId = 1n;

  const prisma: FakePrisma = {
    activityRow: {
      async create({ data }) {
        // Keep what the recorder actually handed us, before normalisation —
        // the WARP-2484 case below asserts on the sentinel itself.
        rawRefs.push(data.refs);
        // Mirror the recorder's normalisation: `Prisma.DbNull` becomes a real
        // `null` once it lands in the table. Since WARP-2484 the shared mock
        // exports the genuine sentinel object, so this is a plain identity
        // check — no more sniffing a `_tag` because the mock had no value to
        // compare against.
        const refsValue =
          data.refs === Prisma.DbNull
            ? null
            : (data.refs as Record<string, unknown> | null);
        const row: FakeActivityRow = {
          id: nextId++,
          at: data.at as Date,
          severity: data.severity as FakeActivityRow["severity"],
          sourceIcon: data.sourceIcon as string,
          what: data.what as string,
          sub: (data.sub as string | null) ?? null,
          kind: data.kind as FakeActivityRow["kind"],
          refs: refsValue,
          signature: data.signature as string,
          prevSignatureHash: data.prevSignatureHash as string,
          actorType: (data.actorType as FakeActivityRow["actorType"]) ?? null,
          actorId: (data.actorId as string | null) ?? null,
          schemaVersion: data.schemaVersion as number,
        };
        rows.push(row);
        return row;
      },
    },
    async $queryRawUnsafe<T>(query: string) {
      queries.push(query);
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
  return { prisma, rows, transactionCount, queries, rawRefs };
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
  });

  it("writes Prisma.DbNull, not undefined, when there are no refs (WARP-2484)", async () => {
    // The recorder deliberately sends the sentinel rather than `undefined`:
    // Prisma OMITS an undefined field, so the column would keep its default
    // instead of being set to SQL NULL. This used to be unassertable — the
    // shared `@prisma/client` mock exported no `DbNull`, so the sentinel and
    // `undefined` were the same value and every check on it passed vacuously.
    const row = await recorder.record({
      kind: "auth",
      severity: "ok",
      sourceIcon: "log-in",
      what: "Alice signed in",
      actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    });

    const written = prismaState.rawRefs[0];
    expect(written).not.toBeUndefined();
    expect(written).toBe(Prisma.DbNull);
    // …and the fake normalises it to a real null on the way into the row.
    expect(row.refs).toBeNull();
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
