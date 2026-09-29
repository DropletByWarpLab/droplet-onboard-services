/**
 * WARP-456 — GET /api/activity + POST /api/activity/export.
 *
 * Both routes are owner/admin-only. The list route paginates and
 * filters; the export route streams a sealed JSON-Lines bundle that
 * an offline verifier can replay the chain through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  X509Certificate,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import {
  createActivityRouter,
  type ActivityBundleSealer,
} from "../routes/activity.js";
import {
  createHmacSigner,
  hashSignature,
  _setDefaultSignerForTests,
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
  actorType: "user" | "ai" | "system" | "anonymous" | null;
  actorId: string | null;
  schemaVersion: number;
}

function makeRow(over: Partial<FakeRow>, id: number): FakeRow {
  return {
    id: BigInt(id),
    at: new Date(`2026-05-25T${10 + id}:00:00.000Z`),
    severity: "info",
    sourceIcon: "info",
    what: "event",
    sub: null,
    kind: "system",
    refs: null,
    signature: `sig-${id}`,
    prevSignatureHash: id === 1 ? "" : `hash-${id - 1}`,
    actorType: "system",
    actorId: null,
    schemaVersion: 2,
    ...over,
  };
}

const KEY = Buffer.from("warp-456-test-key-bytes-must-be-long", "utf8");

/**
 * WARP-3153: stand-in for device-identity-svc, with the real key type:
 * ECDSA P-256, DER signatures (what the sidecar's `Sign` returns). Node
 * cannot build X.509 certs, so openssl self-signs one, as the sidecar does.
 */
const DEVICE = (() => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(path.join(tmpdir(), "device-"));
  writeFileSync(path.join(dir, "key.pem"), privatePem);
  const certPem = execFileSync(
    "openssl",
    ["req", "-x509", "-new", "-key", path.join(dir, "key.pem"), "-subj", "/CN=droplet-test-device", "-days", "30"],
    { encoding: "utf8" },
  );
  return { privatePem, certPem };
})();
const FP = `sha256:${createHash("sha256").update(DEVICE.certPem, "utf8").digest("hex")}`;
const SEAL_PREFIX = "droplet-activity-bundle:v3:";

function deviceSign(payload: Uint8Array) {
  return { signature: cryptoSign("sha256", payload, DEVICE.privatePem), algorithm: "ECDSA-P256-SHA256" };
}

const sealer: ActivityBundleSealer = {
  async getDeviceCert() {
    return DEVICE.certPem;
  },
  async signWithDeviceKey(payload) {
    return deviceSign(payload);
  },
};

/** Replace the bundle's seal line with `edit(seal)`. */
function editSeal(bundle: string, edit: (seal: any) => void): string {
  const lines = bundle.trimEnd().split("\n");
  const seal = JSON.parse(lines.at(-1)!);
  edit(seal);
  lines[lines.length - 1] = JSON.stringify(seal);
  return lines.join("\n") + "\n";
}

/** Edit one field of the SIGNED statement, keeping the old signature. */
function editStatement(bundle: string, edit: (stmt: any) => void): string {
  return editSeal(bundle, (seal) => {
    const stmt = JSON.parse(seal.statement);
    edit(stmt);
    seal.statement = JSON.stringify(stmt);
  });
}

const VERIFIER = path.resolve(
  __dirname,
  "../../../../scripts/verify-activity-bundle.mjs",
);

/** Run the shipped offline verifier on a bundle; returns exit code + output. */
function runVerifier(bundle: string, ...args: string[]) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bundle-")), "b.jsonl");
  writeFileSync(file, bundle);
  try {
    const out = execFileSync(process.execPath, [VERIFIER, file, ...args], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

/** Rows genuinely HMAC-chained with KEY, as the recorder writes them. */
function signedChain(n: number): FakeRow[] {
  const signer = createHmacSigner(KEY);
  const rows: FakeRow[] = [];
  let prev = "";
  for (let i = 1; i <= n; i++) {
    const r = makeRow({ prevSignatureHash: prev, what: `event ${i}` }, i);
    r.signature = signer.sign(
      { ...r, severity: r.severity, kind: r.kind as "system" },
      prev,
    );
    rows.push(r);
    prev = hashSignature(r.signature);
  }
  return rows;
}

function makeApp(rows: FakeRow[], bundleSealer: ActivityBundleSealer | null = sealer) {
  const prisma = {
    activityRow: {
      async findMany({ where, orderBy, take }: any) {
        let filtered = [...rows];
        if (where?.kind) {
          filtered = filtered.filter((r) => r.kind === where.kind);
        }
        if (where?.actorType) {
          filtered = filtered.filter((r) => r.actorType === where.actorType);
        }
        if (where?.actorId) {
          filtered = filtered.filter((r) => r.actorId === where.actorId);
        }
        if (where?.schemaVersion?.gt !== undefined) {
          filtered = filtered.filter(
            (r) => r.schemaVersion > where.schemaVersion.gt,
          );
        }
        if (where?.at) {
          if (where.at.gte) {
            filtered = filtered.filter((r) => r.at >= where.at.gte);
          }
          if (where.at.lt) {
            filtered = filtered.filter((r) => r.at < where.at.lt);
          }
        }
        if (where?.OR) {
          // q-substring filter — both clauses share the same substring
          const needle = (where.OR[0].what?.contains ?? "").toLowerCase();
          filtered = filtered.filter(
            (r) =>
              r.what.toLowerCase().includes(needle) ||
              (r.sub?.toLowerCase().includes(needle) ?? false),
          );
        }
        if (where?.id?.lt) {
          filtered = filtered.filter((r) => r.id < where.id.lt);
        }
        if (where?.id?.gt) {
          filtered = filtered.filter((r) => r.id > where.id.gt);
        }
        if (orderBy?.id === "desc") {
          filtered.sort((a, b) => (b.id > a.id ? 1 : -1));
        } else if (orderBy?.id === "asc") {
          filtered.sort((a, b) => (a.id > b.id ? 1 : -1));
        }
        return take ? filtered.slice(0, take) : filtered;
      },
    },
  };

  const app = express();
  app.use(express.json());
  // Stub auth middleware: every request is owner.
  app.use((req, _res, next) => {
    (req as any).user = { id: "alice", role: "owner", username: "alice" };
    next();
  });
  app.use("/api", createActivityRouter(prisma as never, bundleSealer));
  return app;
}

describe("GET /api/activity", () => {
  beforeEach(() => {
    const signer = createHmacSigner(KEY);
    _setDefaultSignerForTests(signer);
    _setActivityRecorderForTests(null, signer);
  });

  it("returns rows in descending id order", async () => {
    const rows = [makeRow({}, 1), makeRow({}, 2), makeRow({}, 3)];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].id).toBe("3");
    expect(res.body.items[2].id).toBe("1");
  });

  it("filters by kind", async () => {
    const rows = [
      makeRow({ kind: "chat" }, 1),
      makeRow({ kind: "file" }, 2),
      makeRow({ kind: "chat" }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?kind=chat");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((r: any) => r.kind === "chat")).toBe(true);
  });

  it("filters by [from, to)", async () => {
    const rows = [
      makeRow({ at: new Date("2026-05-25T11:00:00Z") }, 1),
      makeRow({ at: new Date("2026-05-25T12:00:00Z") }, 2),
      makeRow({ at: new Date("2026-05-25T13:00:00Z") }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get(
      "/api/activity?from=2026-05-25T11:30:00Z&to=2026-05-25T12:30:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("2");
  });

  it("substring search on what / sub via q", async () => {
    const rows = [
      makeRow({ what: "Alice signed in", sub: "from 10.0.0.1" }, 1),
      makeRow({ what: "Tool list_files", sub: "for bob" }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?q=ALICE");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("1");
  });

  it("paginates with cursor + limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({}, i + 1));
    const app = makeApp(rows);
    const page1 = await request(app).get("/api/activity?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBe("4"); // tail of desc page
    const page2 = await request(app).get(
      `/api/activity?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((r: any) => r.id)).toEqual(["3", "2"]);
  });

  it("returns 400 on invalid kind", async () => {
    const app = makeApp([]);
    const res = await request(app).get("/api/activity?kind=bogus");
    expect(res.status).toBe(400);
  });

  it("filters by actorType (WARP-181)", async () => {
    const rows = [
      makeRow({ actorType: "user", actorId: "uuid-alice" }, 1),
      makeRow({ actorType: "system" }, 2),
      makeRow({ actorType: "user", actorId: "uuid-bob" }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?actorType=user");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((r: any) => r.actorType === "user")).toBe(true);
  });

  it("filters by actorId (WARP-181)", async () => {
    const rows = [
      makeRow({ actorType: "user", actorId: "uuid-alice" }, 1),
      makeRow({ actorType: "user", actorId: "uuid-bob" }, 2),
      makeRow({ actorType: "ai", actorId: "uuid-alice" }, 3),
    ];
    const app = makeApp(rows);
    const res = await request(app).get("/api/activity?actorId=uuid-alice");
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: any) => r.id)).toEqual(["3", "1"]);
  });

  it("returns 400 on an invalid actorType", async () => {
    const app = makeApp([]);
    const res = await request(app).get("/api/activity?actorType=robot");
    expect(res.status).toBe(400);
  });

  it("items carry actorType and actorId (WARP-181)", async () => {
    const app = makeApp([
      makeRow({ actorType: "user", actorId: "uuid-alice" }, 1),
    ]);
    const res = await request(app).get("/api/activity");
    expect(res.body.items[0].actorType).toBe("user");
    expect(res.body.items[0].actorId).toBe("uuid-alice");
  });

  it("actor filters never match unsigned v1 actor columns (poisoned row excluded)", async () => {
    // v1 actor columns are the only fields writable without breaking
    // the chain; legitimate v1 rows have them NULL. A maliciously
    // decorated v1 row must not surface in \"everything Alice did\".
    const app = makeApp([
      makeRow(
        { schemaVersion: 1, actorType: "user", actorId: "uuid-alice" },
        1,
      ),
      makeRow(
        { schemaVersion: 2, actorType: "user", actorId: "uuid-alice" },
        2,
      ),
    ]);
    const byId = await request(app).get("/api/activity?actorId=uuid-alice");
    expect(byId.status).toBe(200);
    expect(byId.body.items.map((r: any) => r.id)).toEqual(["2"]);
    const byType = await request(app).get("/api/activity?actorType=user");
    expect(byType.body.items.map((r: any) => r.id)).toEqual(["2"]);
  });

  it("nulls actor fields on v1 rows — unsigned actor columns are never served as truth (WARP-181)", async () => {
    // On a schemaVersion=1 row the signature does NOT cover actorType/
    // actorId and the recorder never writes them there — any non-NULL
    // value is tampering or a bug. The list API must not present it.
    const app = makeApp([
      makeRow(
        { schemaVersion: 1, actorType: "user", actorId: "uuid-mallory" },
        1,
      ),
      makeRow({ schemaVersion: 2, actorType: "user", actorId: "uuid-alice" }, 2),
    ]);
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    const v1 = res.body.items.find((r: any) => r.id === "1");
    const v2 = res.body.items.find((r: any) => r.id === "2");
    expect(v1.actorType).toBeNull();
    expect(v1.actorId).toBeNull();
    expect(v2.actorType).toBe("user");
    expect(v2.actorId).toBe("uuid-alice");
  });

  it("serializes BigInt id as string", async () => {
    const app = makeApp([makeRow({}, 1)]);
    const res = await request(app).get("/api/activity");
    expect(typeof res.body.items[0].id).toBe("string");
    expect(res.body.items[0].id).toBe("1");
  });
});

describe("POST /api/activity/export", () => {
  beforeEach(() => {
    const signer = createHmacSigner(KEY);
    _setDefaultSignerForTests(signer);
    _setActivityRecorderForTests(null, signer);
  });

  it("returns a JSON-Lines body with manifest + rows in ascending id order", async () => {
    const rows = [makeRow({}, 1), makeRow({}, 2), makeRow({}, 3)];
    const app = makeApp(rows);
    const res = await request(app).post("/api/activity/export").send({});
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5); // manifest + 3 rows + seal
    // WARP-3153: v3 = no signing key inside, device-key seal last.
    expect(lines[0].type).toBe("droplet.activity-bundle.v3");
    expect(lines[0].rowAlgorithm).toBe("HMAC-SHA256");
    expect(lines[0].deviceCertPem).toBe(DEVICE.certPem);
    expect(lines[1].id).toBe("1");
    expect(lines[2].id).toBe("2");
    expect(lines[3].id).toBe("3");
    expect(lines[4].type).toBe("droplet.activity-bundle.v3.seal");
    expect(JSON.parse(lines[4].statement).rowCount).toBe(3);
  });

  it("respects the filter shape in the request body", async () => {
    const rows = [
      makeRow({ kind: "chat" }, 1),
      makeRow({ kind: "auth" }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ kind: "auth" });
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3); // manifest + 1 row + seal
    expect(lines[1].kind).toBe("auth");
  });

  it("returns 400 on an invalid filter", async () => {
    const app = makeApp([]);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ kind: "totally-made-up" });
    expect(res.status).toBe(400);
  });

  it("export rows include actorType, actorId and schemaVersion (WARP-181)", async () => {
    const rows = [
      makeRow({ actorType: "user", actorId: "uuid-alice" }, 1),
      makeRow({ actorType: "system", actorId: null, schemaVersion: 2 }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app).post("/api/activity/export").send({});
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[1].actorType).toBe("user");
    expect(lines[1].actorId).toBe("uuid-alice");
    expect(lines[1].schemaVersion).toBe(2);
    expect(lines[2].actorType).toBe("system");
    expect(lines[2].actorId).toBeNull();
  });

  it("export preserves v1 actor columns verbatim-as-stored (raw sealed bundle)", async () => {
    // The bundle is the raw table: rows carry schemaVersion, so an
    // offline verifier knows actor fields are unsigned on v1 rows and
    // can flag them itself. The exporter must not editorialize.
    const app = makeApp([
      makeRow(
        { schemaVersion: 1, actorType: "user", actorId: "uuid-mallory" },
        1,
      ),
    ]);
    const res = await request(app).post("/api/activity/export").send({});
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[1].schemaVersion).toBe(1);
    expect(lines[1].actorType).toBe("user");
    expect(lines[1].actorId).toBe("uuid-mallory");
  });

  it("export actor filters never match unsigned v1 actor columns (poisoned row excluded)", async () => {
    const app = makeApp([
      makeRow(
        { schemaVersion: 1, actorType: "user", actorId: "uuid-alice" },
        1,
      ),
      makeRow(
        { schemaVersion: 2, actorType: "user", actorId: "uuid-alice" },
        2,
      ),
    ]);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ actorId: "uuid-alice" });
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3); // manifest + ONLY the v2 row + seal
    expect(lines[1].id).toBe("2");
    expect(lines[1].schemaVersion).toBe(2);
  });

  it("export accepts actor filters in the body (WARP-181)", async () => {
    const rows = [
      makeRow({ actorType: "user", actorId: "uuid-alice" }, 1),
      makeRow({ actorType: "ai", actorId: null }, 2),
    ];
    const app = makeApp(rows);
    const res = await request(app)
      .post("/api/activity/export")
      .send({ actorType: "ai" });
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3); // manifest + 1 row + seal
    expect(lines[1].actorType).toBe("ai");
  });

  // ── WARP-3153: the signing key never leaves the box ──

  it("carries no private key material: no PEM private-key marker, no HMAC key, no device key", async () => {
    const res = await request(signedApp()).post("/api/activity/export").send({});
    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).not.toMatch(/PRIVATE KEY/);
    // The HMAC key in every encoding it could plausibly be shipped in.
    for (const enc of ["utf8", "base64", "base64url", "hex"] as const) {
      expect(text).not.toContain(KEY.toString(enc));
    }
    // The device private key: its PEM body, and the raw P-256 scalar `d`.
    const derB64 = DEVICE.privatePem.replace(/-----[^-]+-----|\s/g, "");
    expect(text).not.toContain(derB64);
    const d = Buffer.from(
      (createPrivateKey(DEVICE.privatePem).export({ format: "jwk" }) as { d: string }).d,
      "base64url",
    );
    for (const enc of ["base64", "base64url", "hex"] as const) {
      expect(text).not.toContain(d.toString(enc));
    }
    expect(JSON.parse(text.split("\n")[0]!)).not.toHaveProperty("publicKey");
  });

  it("verifies offline with the shipped verifier, with no secret", async () => {
    const res = await request(signedApp()).post("/api/activity/export").send({});
    const r = runVerifier(res.text, "--fingerprint", FP);
    expect(r.out).toContain("OK: 3 row(s)");
    expect(r.code).toBe(0);
  });

  it("the seal is an ECDSA P-256 DER signature over the domain prefix + the statement", async () => {
    const res = await request(signedApp()).post("/api/activity/export").send({});
    const seal = JSON.parse(res.text.trimEnd().split("\n").at(-1)!);
    const sig = Buffer.from(seal.signature, "base64");
    expect(sig[0]).toBe(0x30); // DER SEQUENCE, not raw r||s
    const key = new X509Certificate(DEVICE.certPem).publicKey;
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cryptoVerify("sha256", Buffer.from(SEAL_PREFIX + seal.statement), key, sig)).toBe(true);
    // Without the prefix the same bytes do not verify: no cross-domain replay.
    expect(cryptoVerify("sha256", Buffer.from(seal.statement), key, sig)).toBe(false);
  });

  it("the verifier rejects an edited row, deleted head rows and a wrong device", async () => {
    const res = await request(signedApp()).post("/api/activity/export").send({});

    const edited = res.text.replace("event 2", "event X");
    expect(runVerifier(edited, "--fingerprint", FP).out).toContain("digest mismatch");

    // Drop the first row (line 2): the digest no longer matches.
    const lines = res.text.split("\n");
    const headless = [lines[0], ...lines.slice(2)].join("\n");
    const r = runVerifier(headless, "--fingerprint", FP);
    expect(r.code).toBe(1);
    expect(r.out).toContain("digest mismatch");

    // A forger with their own key can make a self-consistent bundle, but it
    // does not match the box's fingerprint.
    expect(runVerifier(res.text, "--fingerprint", "sha256:" + "0".repeat(64)).code).toBe(1);
  });

  it("every seal field is covered by the signature: tampering any of them fails", async () => {
    // Start from a bundle whose box-side HMAC check FAILED on one row.
    const rows = signedChain(3);
    rows[1]!.what = "rewritten in the database";
    const res = await request(makeApp(rows)).post("/api/activity/export").send({});
    const stmt = JSON.parse(JSON.parse(res.text.trimEnd().split("\n").at(-1)!).statement);
    expect(stmt.rowHmac).toEqual({ checked: 3, failed: 1, failedRowIds: ["2"] });
    expect(runVerifier(res.text, "--fingerprint", FP).out).toContain("failing its HMAC check");

    const tamperings: Array<(s: any) => void> = [
      (s) => { s.rowHmac.failed = 0; s.rowHmac.failedRowIds = []; },
      (s) => { s.rowHmac.checked = 99; },
      (s) => { s.rowCount = 2; },
      (s) => { s.digest = "A".repeat(43); },
      (s) => { s.type = "something.else"; },
    ];
    for (const t of tamperings) {
      const out = runVerifier(editStatement(res.text, t), "--fingerprint", FP);
      expect(out.code).toBe(1);
      expect(out.out).toContain("seal signature does not verify");
    }
    // Stripping or emptying the signature, or swapping algorithm, never helps.
    expect(runVerifier(editSeal(res.text, (s) => { s.signature = ""; }), "--fingerprint", FP).code).toBe(1);
    expect(runVerifier(editSeal(res.text, (s) => { delete s.signature; }), "--fingerprint", FP).code).toBe(1);
  });

  it("the verifier requires rowHmac.checked to equal the rows in the file", async () => {
    // A seal the device key really signed, but whose HMAC check doesn't
    // cover every row in the file.
    const res = await request(signedApp()).post("/api/activity/export").send({});
    const lines = res.text.trimEnd().split("\n");
    const seal = JSON.parse(lines.at(-1)!);
    const stmt = JSON.parse(seal.statement);
    stmt.rowHmac.checked = 2;
    seal.statement = JSON.stringify(stmt);
    seal.signature = deviceSign(Buffer.from(SEAL_PREFIX + seal.statement)).signature.toString("base64");
    lines[lines.length - 1] = JSON.stringify(seal);
    const out = runVerifier(lines.join("\n") + "\n", "--fingerprint", FP);
    expect(out.code).toBe(1);
    expect(out.out).toContain("box HMAC check covered 2 row(s)");
  });

  it("requires --fingerprint unless --no-fingerprint is passed, which warns loudly", async () => {
    const res = await request(signedApp()).post("/api/activity/export").send({});
    const bare = runVerifier(res.text);
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("no --fingerprint given");
    const unpinned = runVerifier(res.text, "--no-fingerprint");
    expect(unpinned.code).toBe(0);
    expect(unpinned.out).toContain("ORIGIN IS NOT");
  });

  it("refuses with 503 when the bundle cannot be sealed", async () => {
    const res = await request(makeApp(signedChain(1), null))
      .post("/api/activity/export")
      .send({});
    expect(res.status).toBe(503);
  });

  it("refuses with 503 when the device key signs with an empty signature (TPM placeholder)", async () => {
    const empty: ActivityBundleSealer = {
      getDeviceCert: sealer.getDeviceCert,
      async signWithDeviceKey() {
        return { signature: new Uint8Array(0), algorithm: "ECDSA-P256-SHA256" };
      },
    };
    const res = await request(makeApp(signedChain(1), empty))
      .post("/api/activity/export")
      .send({});
    expect(res.status).toBe(503);
  });

  it("writes an unsigned seal (which fails verification) if signing breaks mid-export", async () => {
    for (const late of ["throw", "empty"] as const) {
      let calls = 0;
      const recorded: Array<Record<string, unknown>> = [];
      _setActivityRecorderForTests(
        {
          async record(params: Record<string, unknown>) {
            recorded.push(params);
            return null;
          },
        } as never,
        createHmacSigner(KEY),
      );
      const flaky: ActivityBundleSealer = {
        getDeviceCert: sealer.getDeviceCert,
        async signWithDeviceKey(payload) {
          calls += 1;
          if (calls === 1) return deviceSign(payload); // the up-front probe
          if (late === "throw") throw new Error("tpm wedged");
          return { signature: new Uint8Array(0), algorithm: "ECDSA-P256-SHA256" };
        },
      };
      const res = await request(makeApp(signedChain(2), flaky))
        .post("/api/activity/export")
        .send({});
      await new Promise((r) => setImmediate(r));
      const seal = JSON.parse(res.text.trimEnd().split("\n").at(-1)!);
      expect(seal.signature).toBeUndefined();
      expect(seal.error).toBeDefined();
      expect(runVerifier(res.text, "--fingerprint", FP).code).toBe(1);
      expect((recorded[0] as { refs: { sealed: boolean } }).refs.sealed).toBe(false);
    }
  });
});

function signedApp() {
  return makeApp(signedChain(3));
}

describe("POST /api/activity/export — the export is itself audited", () => {
  /**
   * Taking the entire signed chain off the box used to leave no trace in
   * it. An audit log whose own export is unlogged cannot answer "who took
   * a copy of this, and when".
   */
  function capturingRecorder() {
    const recorded: Array<Record<string, unknown>> = [];
    const signer = createHmacSigner(KEY);
    _setActivityRecorderForTests(
      {
        async record(params: Record<string, unknown>) {
          recorded.push(params);
          return null;
        },
      } as never,
      signer,
    );
    return recorded;
  }

  it("records who exported, how many rows, and the filter they used", async () => {
    const recorded = capturingRecorder();
    const app = makeApp([
      makeRow({ kind: "auth" }, 1),
      makeRow({ kind: "auth" }, 2),
      makeRow({}, 3),
    ]);

    const res = await request(app)
      .post("/api/activity/export")
      .send({ kind: "auth" });
    expect(res.status).toBe(200);

    // The row is appended after res.end(), so let the detached promise run.
    await new Promise((r) => setImmediate(r));

    expect(recorded).toHaveLength(1);
    const row = recorded[0] as {
      kind: string;
      severity: string;
      what: string;
      sub: string;
      refs: { rowCount: number; filter: { kind?: string } };
    };
    expect(row.kind).toBe("system");
    expect(row.severity).toBe("warn");
    expect(row.what).toBe("Audit bundle exported");
    expect(row.sub).toContain("auth");
    expect(row.refs.rowCount).toBeGreaterThan(0);
    expect(row.refs.filter.kind).toBe("auth");
  });

  it("counts the rows that actually left the box", async () => {
    const recorded = capturingRecorder();
    const app = makeApp([makeRow({}, 1), makeRow({}, 2)]);

    await request(app).post("/api/activity/export").send({});
    await new Promise((r) => setImmediate(r));

    expect((recorded[0] as { refs: { rowCount: number } }).refs.rowCount).toBe(2);
  });

  it("does not fail the export when the recorder is unavailable", async () => {
    // recordActivity returns null pre-init and swallows recorder errors —
    // a download that already streamed must not turn into a 500.
    const signer = createHmacSigner(KEY);
    _setActivityRecorderForTests(null, signer);
    const app = makeApp([makeRow({}, 1)]);

    const res = await request(app).post("/api/activity/export").send({});

    expect(res.status).toBe(200);
    expect(res.text.trim().split("\n")).toHaveLength(3);
  });
});
