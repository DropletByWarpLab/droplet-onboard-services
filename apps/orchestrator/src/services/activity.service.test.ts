/**
 * WARP-456 — `activity.service.record()` atomic emitter.
 *
 * Verifies the chain semantics on top of an in-memory Prisma fake:
 *   - genesis row has prevSignatureHash = "" and its signature is
 *     computed over content + "".
 *   - every subsequent row reads the most-recent signature and uses
 *     `hashSignature(prev)` as the prev pointer.
 *   - the recorder uses a Prisma transaction so two concurrent
 *     emitters can't both observe the same "latest" row and produce
 *     a broken chain.
 *
 * The full route-level coverage (signature verify, tamper detection,
 * replay correctness) lives in `activity-chain.test.ts` per AC7.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
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
} {
  const rows: FakeActivityRow[] = [];
  const transactionCount = { count: 0 };
  let nextId = 1n;

  const prisma: FakePrisma = {
    activityRow: {
      async create({ data }) {
        // Mirror the recorder's normalisation: `Prisma.DbNull` becomes
        // a real `null` once it lands in the table.
        const refs = (data.refs as unknown) === undefined ? null : data.refs;
        // Detect the Prisma.DbNull sentinel by its toString — the global
        // Prisma mock doesn't expose the real value.
        const refsValue =
          refs &&
          typeof refs === "object" &&
          (refs as { _tag?: string })._tag === "Prisma.DbNull"
            ? null
            : (refs as Record<string, unknown> | null);
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
    async $queryRawUnsafe<T>() {
      // Recorder asks for the tail row's signature ordered by id desc.
      if (rows.length === 0) return [] as unknown as T;
      return [{ signature: rows[rows.length - 1]!.signature }] as unknown as T;
    },
    async $transaction(fn) {
      transactionCount.count++;
      return fn(prisma);
    },
  };
  return { prisma, rows, transactionCount };
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
