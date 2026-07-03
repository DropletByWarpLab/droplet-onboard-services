/**
 * WARP-456 — full chain integrity: AC7.
 *
 * End-to-end coverage of the signed activity log:
 *   - signature verification across a multi-row chain
 *   - hash-chain integrity (prev pointers form the unbroken graph)
 *   - tamper detection (mutating any field of any row breaks the
 *     chain at that row and every row after it)
 *   - replay correctness — given the exported bundle's `publicKey`
 *     + canonical-content shape, an offline verifier reaches the
 *     same conclusion as the recorder.
 *
 * The recorder writes via an in-memory Prisma fake; tests then walk
 * the persisted rows the same way `POST /api/activity/export` does,
 * proving the bundle is verifiable without going through the live
 * orchestrator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createActivityRecorder,
  type ActivityRowRecorder,
} from "../services/activity.service.js";
import {
  canonicalizeRowContent,
  createHmacSigner,
  hashSignature,
  type ActivityRowContent,
  type ActivityRowSigner,
} from "../services/audit-signing.service.js";

interface StoredRow {
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

function makePrismaFake() {
  const rows: StoredRow[] = [];
  let nextId = 1n;
  return {
    rows,
    prisma: {
      activityRow: {
        async create({ data }: { data: Record<string, unknown> }) {
          const refsRaw = data.refs;
          const refsValue =
            refsRaw === undefined ||
            (typeof refsRaw === "object" &&
              refsRaw !== null &&
              (refsRaw as { _tag?: string })._tag === "Prisma.DbNull")
              ? null
              : (refsRaw as Record<string, unknown> | null);
          const row: StoredRow = {
            id: nextId++,
            at: data.at as Date,
            severity: data.severity as StoredRow["severity"],
            sourceIcon: data.sourceIcon as string,
            what: data.what as string,
            sub: (data.sub as string | null) ?? null,
            kind: data.kind as StoredRow["kind"],
            refs: refsValue,
            signature: data.signature as string,
            prevSignatureHash: data.prevSignatureHash as string,
            actorType: (data.actorType as StoredRow["actorType"]) ?? null,
            actorId: (data.actorId as string | null) ?? null,
            schemaVersion: data.schemaVersion as number,
          };
          rows.push(row);
          return row;
        },
      },
      async $queryRawUnsafe<T>(): Promise<T> {
        if (rows.length === 0) return [] as unknown as T;
        return [
          { signature: rows[rows.length - 1]!.signature },
        ] as unknown as T;
      },
      async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
        return fn(this as never);
      },
    },
  };
}

/**
 * Offline verifier — same algorithm a third-party tool will run on
 * the exported bundle. Walks the chain forward, recomputing each
 * row's expected signature from its content + the previous row's
 * sig-hash. Returns the index of the first broken row (-1 = chain
 * intact).
 */
function verifyChain(rows: StoredRow[], signer: ActivityRowSigner): number {
  let expectedPrev = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.prevSignatureHash !== expectedPrev) return i;
    const content: ActivityRowContent = {
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
    if (!signer.verify(content, expectedPrev, r.signature)) return i;
    expectedPrev = hashSignature(r.signature);
  }
  return -1;
}

const KEY = Buffer.from("warp-456-test-key-bytes-must-be-long", "utf8");

describe("WARP-456 — full chain integrity", () => {
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

  async function seedChain(count: number): Promise<StoredRow[]> {
    const seeded: StoredRow[] = [];
    for (let i = 0; i < count; i++) {
      await recorder.record({
        kind: i % 2 === 0 ? "chat" : "tool_call",
        severity: "ok",
        sourceIcon: i % 2 === 0 ? "message-square" : "wrench",
        what: `event-${i}`,
        sub: i % 3 === 0 ? `iteration ${i}` : null,
        refs: { i },
        actor: i % 2 === 0 ? { type: "user", id: "uuid-alice" } : { type: "ai", id: null },
      });
      seeded.push(prismaState.rows[i]!);
    }
    return seeded;
  }

  // ── Signature verification ──

  it("verifies a 10-row chain end-to-end", async () => {
    await seedChain(10);
    expect(verifyChain(prismaState.rows, signer)).toBe(-1);
  });

  it("each row carries the canonical content the signer can re-verify", async () => {
    await seedChain(3);
    for (const r of prismaState.rows) {
      const content: ActivityRowContent = {
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
      expect(signer.verify(content, r.prevSignatureHash, r.signature)).toBe(
        true,
      );
    }
  });

  // ── Hash-chain integrity ──

  it("genesis row has prevSignatureHash = '' and every other row's prev = hash(previous.signature)", async () => {
    await seedChain(5);
    expect(prismaState.rows[0]!.prevSignatureHash).toBe("");
    for (let i = 1; i < prismaState.rows.length; i++) {
      expect(prismaState.rows[i]!.prevSignatureHash).toBe(
        hashSignature(prismaState.rows[i - 1]!.signature),
      );
    }
  });

  it("canonical JSON is order-stable so the chain is portable across emitters", async () => {
    const a = canonicalizeRowContent({
      at: new Date("2026-05-25T12:00:00Z"),
      kind: "chat",
      refs: { z: 1, a: 2, m: 3 },
      severity: "ok",
      sourceIcon: "message-square",
      sub: null,
      what: "x",
      actorType: "user",
      actorId: "uuid-alice",
      schemaVersion: 2,
    });
    const b = canonicalizeRowContent({
      at: new Date("2026-05-25T12:00:00Z"),
      kind: "chat",
      refs: { m: 3, a: 2, z: 1 }, // shuffled
      severity: "ok",
      sourceIcon: "message-square",
      sub: null,
      what: "x",
      actorType: "user",
      actorId: "uuid-alice",
      schemaVersion: 2,
    });
    expect(a).toBe(b);
  });

  // ── Tamper detection ──

  it("mutating `what` on a middle row breaks the chain at that row", async () => {
    await seedChain(5);
    // Mutate row 2 (0-indexed) in place — a sophisticated attacker
    // who has DB access tries to rewrite history.
    prismaState.rows[2]!.what = "ATTACKER MODIFIED";
    const brokenAt = verifyChain(prismaState.rows, signer);
    expect(brokenAt).toBe(2);
  });

  it("mutating `refs` on a tail row breaks the chain at that row", async () => {
    await seedChain(4);
    prismaState.rows[3]!.refs = { i: 999 };
    expect(verifyChain(prismaState.rows, signer)).toBe(3);
  });

  it("mutating a row's signature breaks subsequent prevSignatureHash linkage", async () => {
    await seedChain(4);
    // Overwrite row 1's signature with bogus value. The row itself
    // becomes unverifiable (signer.verify fails), so the chain
    // breaks at row 1 — which is the expected first-failure index.
    prismaState.rows[1]!.signature = "AAAA";
    const brokenAt = verifyChain(prismaState.rows, signer);
    expect(brokenAt).toBe(1);
  });

  it("inserting a forged row in the middle breaks the chain at that point", async () => {
    await seedChain(3);
    const forged: StoredRow = {
      id: 99n,
      at: new Date("2026-05-25T12:00:00Z"),
      severity: "ok",
      sourceIcon: "wrench",
      what: "forged event",
      sub: null,
      kind: "system",
      refs: null,
      signature: "FORGED",
      prevSignatureHash: prismaState.rows[1]!.prevSignatureHash, // copy from a real row
      actorType: "system",
      actorId: null,
      schemaVersion: 2,
    };
    const tampered = [
      prismaState.rows[0]!,
      forged,
      prismaState.rows[1]!,
      prismaState.rows[2]!,
    ];
    expect(verifyChain(tampered, signer)).toBe(1);
  });

  it("removing a row from the middle breaks the chain at the next row", async () => {
    await seedChain(4);
    // Delete row 1 — row 2's prevSignatureHash now points to row 1's
    // signature, but the verifier expects it to point to row 0's
    // signature after the delete.
    const tampered = [
      prismaState.rows[0]!,
      prismaState.rows[2]!,
      prismaState.rows[3]!,
    ];
    expect(verifyChain(tampered, signer)).toBe(1);
  });

  it("a wrong signing key fails verification at the genesis row", async () => {
    await seedChain(3);
    const wrongKeySigner = createHmacSigner(
      Buffer.from("warp-456-different-key-bytes-also-long", "utf8"),
    );
    expect(verifyChain(prismaState.rows, wrongKeySigner)).toBe(0);
  });

  // ── Replay correctness ──

  it("replay test: walking the bundle in ascending id order recreates each prevSignatureHash", async () => {
    await seedChain(6);
    // Same algorithm POST /api/activity/export ships in the bundle.
    let expectedPrev = "";
    for (const r of prismaState.rows) {
      expect(r.prevSignatureHash).toBe(expectedPrev);
      expectedPrev = hashSignature(r.signature);
    }
  });

  it("offline verifier with only `publicKey` bytes + canonical shape reaches the same verdict", async () => {
    await seedChain(5);
    // Mimic an offline verifier: receive only the row content +
    // metadata + the public bytes — nothing about the orchestrator's
    // process.
    const offlineSigner = createHmacSigner(signer.exportPublicBytes());
    expect(verifyChain(prismaState.rows, offlineSigner)).toBe(-1);
    // Now corrupt one row and re-verify with the offline signer —
    // breaks at the same index a verifier inside the orchestrator
    // would report.
    prismaState.rows[3]!.what = "MODIFIED OFFLINE";
    expect(verifyChain(prismaState.rows, offlineSigner)).toBe(3);
  });

  it("the chain survives mixed kinds + nullable sub/refs", async () => {
    await recorder.record({
      kind: "system",
      severity: "info",
      sourceIcon: "info",
      what: "Boot",
      actor: { type: "system" },
      // no sub, no refs
    });
    await recorder.record({
      kind: "auth",
      severity: "ok",
      sourceIcon: "log-in",
      what: "Sign-in",
      sub: "192.168.50.42",
      actor: { type: "anonymous" },
    });
    await recorder.record({
      kind: "tool_call",
      severity: "ok",
      sourceIcon: "wrench",
      what: "list_files",
      sub: "for alice",
      refs: { name: "list_files", userId: "alice" },
      actor: { type: "ai", id: null },
    });
    expect(verifyChain(prismaState.rows, signer)).toBe(-1);
  });
});
