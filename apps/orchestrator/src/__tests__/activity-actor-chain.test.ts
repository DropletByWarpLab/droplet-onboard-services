/**
 * WARP-181 — actor attribution on the signed activity log (AC2).
 *
 * Covers the chain-version boundary:
 *   - a chain of legacy v1 rows (no actor, 7-key canonical form)
 *     followed by v2 rows (actorId/actorType in lexicographic
 *     position) verifies end-to-end with one verifier that dispatches
 *     on each row's `schemaVersion`;
 *   - tampering an actor field on a v2 row breaks verification at
 *     that row (actor fields are signature-covered);
 *   - tampering `schemaVersion` itself breaks verification (the
 *     canonical shapes differ, so a version flip can't silently
 *     drop or forge the actor).
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

/** Rebuild the signature-covered content from a persisted row —
 * exactly what an offline verifier derives from an export bundle. */
function contentOf(r: StoredRow): ActivityRowContent {
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

/** Offline verifier — walks the chain forward, dispatching the
 * canonical form per row via `schemaVersion`. Returns the index of
 * the first broken row (-1 = chain intact). */
function verifyChain(rows: StoredRow[], signer: ActivityRowSigner): number {
  let expectedPrev = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.prevSignatureHash !== expectedPrev) return i;
    if (!signer.verify(contentOf(r), expectedPrev, r.signature)) return i;
    expectedPrev = hashSignature(r.signature);
  }
  return -1;
}

const KEY = Buffer.from("warp-181-test-key-bytes-must-be-long", "utf8");

/** Append a legacy v1 row (pre-WARP-181 shape: no actor, signed under
 * the 7-key canonical form) directly to the fake store, chaining off
 * the current tail. Mimics rows that existed before the migration. */
function appendLegacyV1Row(
  state: ReturnType<typeof makePrismaFake>,
  signer: ActivityRowSigner,
  i: number,
): void {
  const tail = state.rows[state.rows.length - 1];
  const prevSignatureHash = tail ? hashSignature(tail.signature) : "";
  const content: ActivityRowContent = {
    at: new Date(`2026-05-25T1${i}:00:00.000Z`),
    severity: "info",
    sourceIcon: "info",
    what: `legacy-event-${i}`,
    sub: null,
    kind: "system",
    refs: { i },
    actorType: null,
    actorId: null,
    schemaVersion: 1,
  };
  const signature = signer.sign(content, prevSignatureHash);
  state.rows.push({
    id: BigInt(state.rows.length + 1),
    at: content.at,
    severity: "info",
    sourceIcon: "info",
    what: content.what,
    sub: null,
    kind: "system",
    refs: content.refs,
    signature,
    prevSignatureHash,
    actorType: null,
    actorId: null,
    schemaVersion: 1,
  });
}

describe("WARP-181 — mixed-version chain (v1 rows followed by v2 rows)", () => {
  let signer: ActivityRowSigner;
  let state: ReturnType<typeof makePrismaFake>;
  let recorder: ActivityRowRecorder;

  beforeEach(() => {
    signer = createHmacSigner(KEY);
    state = makePrismaFake();
    recorder = createActivityRecorder({
      prisma: state.prisma as never,
      signer,
    });
  });

  async function seedMixedChain(): Promise<void> {
    // Three pre-upgrade rows signed under the legacy canonical form…
    for (let i = 0; i < 3; i++) appendLegacyV1Row(state, signer, i);
    // …then three post-upgrade rows written by the recorder (v2).
    await recorder.record({
      kind: "auth",
      severity: "ok",
      sourceIcon: "log-in",
      what: "Alice signed in",
      actor: { type: "user", id: "uuid-alice" },
    });
    await recorder.record({
      kind: "tool_call",
      severity: "ok",
      sourceIcon: "wrench",
      what: "Tool list_files",
      actor: { type: "ai", id: null },
    });
    await recorder.record({
      kind: "system",
      severity: "info",
      sourceIcon: "clock",
      what: "Nightly sweep",
      actor: { type: "system" },
    });
  }

  it("verifies a v1→v2 chain end-to-end", async () => {
    await seedMixedChain();
    expect(state.rows).toHaveLength(6);
    expect(state.rows[0]!.schemaVersion).toBe(1);
    expect(state.rows[5]!.schemaVersion).toBe(2);
    expect(verifyChain(state.rows, signer)).toBe(-1);
  });

  it("the recorder writes schemaVersion 2 + actor columns explicitly", async () => {
    await seedMixedChain();
    const v2 = state.rows[3]!;
    expect(v2.schemaVersion).toBe(2);
    expect(v2.actorType).toBe("user");
    expect(v2.actorId).toBe("uuid-alice");
    const ai = state.rows[4]!;
    expect(ai.actorType).toBe("ai");
    expect(ai.actorId).toBeNull();
    const sys = state.rows[5]!;
    expect(sys.actorType).toBe("system");
    expect(sys.actorId).toBeNull();
  });

  it("tampering actorId on a v2 row breaks verification at that row", async () => {
    await seedMixedChain();
    state.rows[3]!.actorId = "uuid-mallory";
    expect(verifyChain(state.rows, signer)).toBe(3);
  });

  it("tampering actorType on a v2 row breaks verification at that row", async () => {
    await seedMixedChain();
    state.rows[4]!.actorType = "system";
    expect(verifyChain(state.rows, signer)).toBe(4);
  });

  it("flipping a v2 row's schemaVersion to 1 (to shed its actor) breaks verification", async () => {
    await seedMixedChain();
    // An attacker who wants to erase attribution can't relabel the row
    // as legacy: the signature was computed over the 9-key v2 form.
    state.rows[3]!.schemaVersion = 1;
    state.rows[3]!.actorType = null;
    state.rows[3]!.actorId = null;
    expect(verifyChain(state.rows, signer)).toBe(3);
  });

  it("flipping a v1 row's schemaVersion to 2 breaks verification", async () => {
    await seedMixedChain();
    state.rows[1]!.schemaVersion = 2;
    state.rows[1]!.actorType = "user";
    state.rows[1]!.actorId = "uuid-forged";
    expect(verifyChain(state.rows, signer)).toBe(1);
  });

  it("v1 rows still verify byte-identically after the upgrade (regression)", async () => {
    await seedMixedChain();
    // The canonical form of a v1 row must be the exact legacy 7-key
    // JSON — no actor keys, no schemaVersion key.
    const canonical = canonicalizeRowContent(contentOf(state.rows[0]!));
    expect(canonical).toBe(
      '{"at":"2026-05-25T10:00:00.000Z","kind":"system","refs":{"i":0},' +
        '"severity":"info","sourceIcon":"info","sub":null,"what":"legacy-event-0"}',
    );
  });
});

describe("WARP-181 — canonical form versioning", () => {
  it("v2 canonical form carries actorId/actorType in lexicographic position", () => {
    const canonical = canonicalizeRowContent({
      at: new Date("2026-07-02T08:00:00.000Z"),
      severity: "ok",
      sourceIcon: "log-in",
      what: "Alice signed in",
      sub: null,
      kind: "auth",
      refs: null,
      actorType: "user",
      actorId: "uuid-alice",
      schemaVersion: 2,
    });
    expect(canonical).toBe(
      '{"actorId":"uuid-alice","actorType":"user",' +
        '"at":"2026-07-02T08:00:00.000Z","kind":"auth","refs":null,' +
        '"severity":"ok","sourceIcon":"log-in","sub":null,"what":"Alice signed in"}',
    );
  });

  it("rejects an unknown schemaVersion (fail closed, never guess a shape)", () => {
    expect(() =>
      canonicalizeRowContent({
        at: new Date("2026-07-02T08:00:00.000Z"),
        severity: "ok",
        sourceIcon: "log-in",
        what: "x",
        sub: null,
        kind: "auth",
        refs: null,
        actorType: "user",
        actorId: "uuid-alice",
        schemaVersion: 3,
      }),
    ).toThrow(/schemaVersion/i);
  });
});

describe("WARP-181 — recorder actor validation (AC3)", () => {
  let signer: ActivityRowSigner;
  let state: ReturnType<typeof makePrismaFake>;
  let recorder: ActivityRowRecorder;

  beforeEach(() => {
    signer = createHmacSigner(KEY);
    state = makePrismaFake();
    recorder = createActivityRecorder({
      prisma: state.prisma as never,
      signer,
    });
  });

  it("rejects a `user` actor without an id", async () => {
    await expect(
      recorder.record({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: "Sign-in",
        actor: { type: "user" },
      }),
    ).rejects.toThrow(/actor.*id/i);
  });

  it("rejects a `user` actor with an empty-string id", async () => {
    await expect(
      recorder.record({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: "Sign-in",
        actor: { type: "user", id: "" },
      }),
    ).rejects.toThrow(/actor.*id/i);
  });

  it("rejects unknown actor types (defense against caller typos)", async () => {
    await expect(
      recorder.record({
        kind: "auth",
        severity: "ok",
        sourceIcon: "log-in",
        what: "Sign-in",
        // @ts-expect-error — testing runtime guard
        actor: { type: "robot" },
      }),
    ).rejects.toThrow(/unknown.*actor/i);
  });

  it("accepts system / ai / anonymous actors without an id", async () => {
    for (const type of ["system", "ai", "anonymous"] as const) {
      const row = await recorder.record({
        kind: "system",
        severity: "info",
        sourceIcon: "info",
        what: `event-${type}`,
        actor: { type },
      });
      expect(row.actorType).toBe(type);
      expect(row.actorId).toBeNull();
      expect(row.schemaVersion).toBe(2);
    }
  });
});
