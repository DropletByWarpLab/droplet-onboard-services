/**
 * WARP-246 — GET /api/activity/verify.
 *
 * Server-side hash-chain verification for the admin audit viewer. The
 * chain is HMAC-signed, so verification can never run client-side (the
 * key must not leave the box); the dashboard badge consumes this
 * endpoint's `{ok, rowsChecked, brokenAtId?, verifiedAt}` result.
 *
 * Chain semantics under test (mirrors activity.service.ts +
 * audit-retention-purge.service.ts):
 *   - rows are walked in ascending `id` order, chunked (PAGE=200);
 *   - the FIRST row examined is the history origin: its stored
 *     `prevSignatureHash` is the anchor (genesis rows carry "", and a
 *     retention-purged head references a signature we no longer have —
 *     both verify against the stored value);
 *   - every subsequent row must link: `prevSignatureHash ===
 *     hashSignature(previous row's signature)`;
 *   - every row's signature must verify over its canonical content +
 *     the expected prev hash.
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createActivityRouter } from "../routes/activity.js";
import {
  createHmacSigner,
  hashSignature,
  _setDefaultSignerForTests,
  type ActivityRowSigner,
  type ActivityRowContent,
} from "../services/audit-signing.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";

interface FakeRow {
  id: bigint;
  at: Date;
  severity: "ok" | "warn" | "err" | "info";
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind: string;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
}

const KEY = Buffer.from("warp-246-test-key-bytes-must-be-long", "utf8");

/** Build a properly signed chain of n rows, ids 1..n. */
function buildChain(signer: ActivityRowSigner, n: number): FakeRow[] {
  const rows: FakeRow[] = [];
  let prevSig = "";
  for (let i = 1; i <= n; i++) {
    const content: ActivityRowContent = {
      // Seconds-granularity spread keeps `at` strictly increasing for
      // up to a day's worth of rows without leaving the fixture date.
      at: new Date(Date.UTC(2026, 4, 25, 10, Math.floor(i / 60), i % 60)),
      severity: "info",
      sourceIcon: "info",
      what: `event ${i}`,
      sub: i % 2 === 0 ? `detail ${i}` : null,
      kind: "system",
      refs: i % 3 === 0 ? { seq: i } : null,
    };
    const prevSignatureHash = prevSig === "" ? "" : hashSignature(prevSig);
    const signature = signer.sign(content, prevSignatureHash);
    rows.push({
      id: BigInt(i),
      at: content.at,
      severity: content.severity,
      sourceIcon: content.sourceIcon,
      what: content.what,
      sub: content.sub,
      kind: content.kind,
      refs: content.refs,
      signature,
      prevSignatureHash,
    });
    prevSig = signature;
  }
  return rows;
}

function makeApp(rows: FakeRow[], role: "owner" | "admin" | "family" = "owner") {
  const prisma = {
    activityRow: {
      async findMany({ where, orderBy, take }: any) {
        let filtered = [...rows];
        if (where?.id?.gt !== undefined) {
          filtered = filtered.filter((r) => r.id > where.id.gt);
        }
        if (orderBy?.id === "asc") {
          filtered.sort((a, b) => (a.id > b.id ? 1 : -1));
        }
        return take ? filtered.slice(0, take) : filtered;
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "alice", role, username: "alice" };
    next();
  });
  app.use("/api", createActivityRouter(prisma as never));
  return app;
}

describe("GET /api/activity/verify", () => {
  let signer: ActivityRowSigner;

  beforeEach(() => {
    signer = createHmacSigner(KEY);
    _setDefaultSignerForTests(signer);
    _setActivityRecorderForTests(null, signer);
  });

  it("is owner/admin-gated (403 for family)", async () => {
    const app = makeApp([], "family");
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(403);
  });

  it("returns 503 when the signer is unavailable", async () => {
    _setActivityRecorderForTests(null, null);
    const app = makeApp([]);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(503);
  });

  it("verifies an empty table as ok with zero rows checked", async () => {
    const app = makeApp([]);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rowsChecked).toBe(0);
    expect(res.body.brokenAtId).toBeUndefined();
    expect(Number.isNaN(Date.parse(res.body.verifiedAt))).toBe(false);
  });

  it("verifies an intact chain end to end", async () => {
    const app = makeApp(buildChain(signer, 5));
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, rowsChecked: 5 });
    expect(res.body.brokenAtId).toBeUndefined();
  });

  it("responds with EXACTLY the documented key set (no signature/key leakage)", async () => {
    // The verify surface must never grow signature bytes, key material,
    // or row content — pin the exact response shape for both outcomes.
    const intact = await request(makeApp(buildChain(signer, 3))).get(
      "/api/activity/verify",
    );
    expect(Object.keys(intact.body).sort()).toEqual([
      "ok",
      "rowsChecked",
      "verifiedAt",
    ]);

    const tampered = buildChain(signer, 3);
    tampered[1]!.what = "tampered";
    const broken = await request(makeApp(tampered)).get("/api/activity/verify");
    expect(Object.keys(broken.body).sort()).toEqual([
      "brokenAtId",
      "ok",
      "rowsChecked",
      "verifiedAt",
    ]);
  });

  it("flags a tampered row's content (negative case)", async () => {
    const rows = buildChain(signer, 5);
    rows[2]!.what = "event 3 — REWRITTEN AFTER THE FACT";
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAtId).toBe("3");
    expect(res.body.rowsChecked).toBe(3);
  });

  it("flags a severed chain link (prevSignatureHash rewritten)", async () => {
    const rows = buildChain(signer, 5);
    rows[3]!.prevSignatureHash = hashSignature("not-the-real-predecessor");
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAtId).toBe("4");
  });

  it("treats a retention-truncated head as the history origin", async () => {
    // Simulate audit-retention-purge: rows 1-2 deleted, 3-5 survive. The
    // surviving head's prevSignatureHash references a purged signature —
    // the verifier must anchor on the stored value, not re-derive it.
    const rows = buildChain(signer, 5).slice(2);
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, rowsChecked: 3 });
  });

  it("walks past the 200-row page boundary (chunked reads)", async () => {
    const app = makeApp(buildChain(signer, 250));
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, rowsChecked: 250 });
  });

  it("detects tampering on the second page", async () => {
    const rows = buildChain(signer, 250);
    rows[204]!.sub = "tampered on page 2";
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity/verify");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAtId).toBe("205");
    expect(res.body.rowsChecked).toBe(205);
  });
});
