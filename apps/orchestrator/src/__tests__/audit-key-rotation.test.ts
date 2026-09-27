/**
 * WARP-3165 — audit key rotation.
 *
 * The chain is walked with the whole keyring under the epoch rule: rows
 * signed before a rotation keep verifying under the archived key, rows after
 * it verify only under the new key, and a row forged with the retired key
 * after the rotation is a break.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";

// recordActivity appends to the fake chain below with the LIVE signer, the
// way the real recorder does (sign under the lock, link to the tail).
const { chain } = vi.hoisted(() => ({ chain: [] as any[] }));
vi.mock("../services/activity.singleton.js", async (importActual) => {
  const actual: any = await importActual();
  return {
    ...actual,
    recordActivity: vi.fn(async (p: any) => {
      const signer = actual.getActivitySigner();
      appendSigned(chain, signer, p.what, p.refs ?? null);
      return null;
    }),
  };
});

import {
  auditKeyId,
  createHmacSigner,
  hashSignature,
  loadRetiredAuditKeys,
  type ActivityRowContent,
  type ActivityRowSigner,
} from "../services/audit-signing.service.js";
import {
  _initActivityRecorderWithKeysForTests,
  _setActivityRecorderForTests,
  getActivitySigner,
  getAuditKeyring,
  getCurrentAuditKeyId,
  recordActivity,
} from "../services/activity.singleton.js";
import { verifyActivityChain } from "../services/audit-verify.service.js";
import {
  AuditKeyRotationError,
  recordRotationFoundAtBoot,
  rotateAuditKey,
} from "../services/audit-key-rotation.service.js";
import { createActivityRouter } from "../routes/activity.js";

function appendSigned(
  rows: any[],
  signer: ActivityRowSigner,
  what: string,
  refs: Record<string, unknown> | null = null,
): void {
  const tail = rows[rows.length - 1];
  const prevSignatureHash = tail ? hashSignature(tail.signature) : "";
  const content: ActivityRowContent = {
    at: new Date(Date.UTC(2026, 8, 25, 10, 0, rows.length)),
    severity: "info",
    sourceIcon: "info",
    what,
    sub: null,
    kind: "system",
    refs,
    actorType: "system",
    actorId: null,
    schemaVersion: 2,
  };
  rows.push({
    ...content,
    id: BigInt(rows.length + 1),
    signature: signer.sign(content, prevSignatureHash),
    prevSignatureHash,
  });
}

function fakePrisma(rows: any[]) {
  return {
    activityRow: {
      async findMany({ where, take }: any) {
        const gt = where?.id?.gt;
        const out = rows.filter((r) => gt === undefined || r.id > gt);
        return take ? out.slice(0, take) : out;
      },
      async findFirst() {
        return rows[rows.length - 1] ?? null;
      },
    },
  } as any;
}

const OLD = randomBytes(32);
const NEW = randomBytes(32);
const ACTOR = { type: "user" as const, id: "owner-1" };

let tmp: string;
beforeEach(() => {
  chain.length = 0;
  vi.mocked(recordActivity).mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rot-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  _setActivityRecorderForTests(null, null);
});

/** The host helper, for tests: archive the old key, "write" the new one. */
function fakeHost(retiredDir: string, oldKey: Buffer, newKey: Buffer) {
  let onDisk = oldKey;
  return {
    runOnHost: vi.fn(async () => {
      fs.writeFileSync(
        path.join(retiredDir, `20260925T120000Z-${auditKeyId(oldKey)}.key`),
        oldKey,
      );
      onDisk = newKey;
    }),
    loadKey: () => onDisk,
  };
}

describe("the epoch rule — verifyActivityChain over a keyring", () => {
  const old = { keyId: auditKeyId(OLD), signer: createHmacSigner(OLD) };
  const neu = { keyId: auditKeyId(NEW), signer: createHmacSigner(NEW) };

  it("old rows verify under the archived key and new rows under the new one", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 3; i += 1) appendSigned(rows, old.signer, `old ${i}`);
    appendSigned(rows, neu.signer, "Audit key rotated");
    appendSigned(rows, neu.signer, "after");
    const res = await verifyActivityChain(fakePrisma(rows), [old, neu]);
    expect(res).toEqual({ ok: true, rowsChecked: 5, brokenAtId: null });
  });

  it("rows appended after the rotation can't be verified with the old key", async () => {
    const rows: any[] = [];
    appendSigned(rows, old.signer, "old");
    appendSigned(rows, neu.signer, "Audit key rotated");
    const res = await verifyActivityChain(fakePrisma(rows), [old]);
    expect(res).toMatchObject({ ok: false, brokenAtId: "2" });
  });

  it("a row forged with the retired key after the rotation is reported", async () => {
    const rows: any[] = [];
    appendSigned(rows, old.signer, "old");
    appendSigned(rows, neu.signer, "Audit key rotated");
    appendSigned(rows, old.signer, "forged with the leaked key");
    appendSigned(rows, neu.signer, "later");
    const res = await verifyActivityChain(fakePrisma(rows), [old, neu]);
    expect(res).toMatchObject({ ok: false, brokenAtId: "3" });
  });

  it("without the archived key the pre-rotation rows no longer verify (why it is kept)", async () => {
    const rows: any[] = [];
    appendSigned(rows, old.signer, "old");
    appendSigned(rows, neu.signer, "Audit key rotated");
    const res = await verifyActivityChain(fakePrisma(rows), [neu]);
    expect(res).toMatchObject({ ok: false, brokenAtId: "1" });
  });
});

describe("rotateAuditKey", () => {
  it("swaps the signing key, archives the old one, and the rotation row is the first new-key row", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD]);
    appendSigned(chain, getActivitySigner()!, "before 1");
    appendSigned(chain, getActivitySigner()!, "before 2");
    const host = fakeHost(tmp, OLD, NEW);

    const res = await rotateAuditKey({
      runOnHost: host.runOnHost,
      loadKey: host.loadKey,
      retiredDir: tmp,
      actor: ACTOR,
      actorUsername: "olivia",
    });

    expect(res).toEqual({ previousKeyId: auditKeyId(OLD), newKeyId: auditKeyId(NEW) });
    expect(getCurrentAuditKeyId()).toBe(auditKeyId(NEW));
    // Archived, not destroyed: the retired key is on disk and loads back.
    expect(loadRetiredAuditKeys(tmp).map((k) => k.keyId)).toEqual([auditKeyId(OLD)]);
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Audit key rotated",
        refs: expect.objectContaining({
          actor: "olivia",
          previousKeyId: auditKeyId(OLD),
          newKeyId: auditKeyId(NEW),
        }),
        actor: ACTOR,
      }),
    );
    // No key bytes in the audit row.
    const refs = JSON.stringify(vi.mocked(recordActivity).mock.calls[0]![0].refs);
    expect(refs).not.toContain(NEW.toString("base64"));
    expect(refs).not.toContain(OLD.toString("base64"));

    // New rows use the new key, and the whole chain verifies.
    appendSigned(chain, getActivitySigner()!, "after");
    const last = chain[chain.length - 1];
    const content = { ...last };
    expect(createHmacSigner(NEW).verify(content, last.prevSignatureHash, last.signature)).toBe(true);
    expect(createHmacSigner(OLD).verify(content, last.prevSignatureHash, last.signature)).toBe(false);
    const verify = await verifyActivityChain(fakePrisma(chain), getAuditKeyring());
    expect(verify).toEqual({ ok: true, rowsChecked: 4, brokenAtId: null });
  });

  it("refuses before touching the key when the retired-key directory isn't mounted", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD]);
    const host = fakeHost(tmp, OLD, NEW);
    await expect(
      rotateAuditKey({
        runOnHost: host.runOnHost,
        loadKey: host.loadKey,
        retiredDir: path.join(tmp, "missing"),
        actor: ACTOR,
        actorUsername: "olivia",
      }),
    ).rejects.toMatchObject({ status: 409, code: "RETIRED_KEY_DIR_MISSING" });
    expect(host.runOnHost).not.toHaveBeenCalled();
    expect(getCurrentAuditKeyId()).toBe(auditKeyId(OLD));
  });

  it("without a host helper it points at the box script (503)", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD]);
    const err = await rotateAuditKey({
      runOnHost: null,
      retiredDir: tmp,
      actor: ACTOR,
      actorUsername: "olivia",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditKeyRotationError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/rotate-audit-key\.sh/);
  });

  it("a failed host step keeps the old key", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD]);
    await expect(
      rotateAuditKey({
        runOnHost: async () => {
          throw new Error("helper exited 1");
        },
        loadKey: () => OLD,
        retiredDir: tmp,
        actor: ACTOR,
        actorUsername: "olivia",
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(getCurrentAuditKeyId()).toBe(auditKeyId(OLD));
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });
});

describe("recordRotationFoundAtBoot (rotation by the box script)", () => {
  it("writes 'Audit key rotated' when the chain's tail was signed by a retired key", async () => {
    appendSigned(chain, createHmacSigner(OLD), "before");
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD, NEW]);
    expect(await recordRotationFoundAtBoot(fakePrisma(chain))).toBe(true);
    expect(vi.mocked(recordActivity)).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Audit key rotated",
        refs: expect.objectContaining({ via: "script", newKeyId: auditKeyId(NEW) }),
        actor: { type: "system", id: null },
      }),
    );
    const verify = await verifyActivityChain(fakePrisma(chain), getAuditKeyring());
    expect(verify.ok).toBe(true);
  });

  it("does nothing on an ordinary restart", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD, NEW]);
    appendSigned(chain, getActivitySigner()!, "current");
    expect(await recordRotationFoundAtBoot(fakePrisma(chain))).toBe(false);
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });
});

describe("loadRetiredAuditKeys", () => {
  it("returns keys oldest first and skips a file whose bytes don't match its name", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    fs.writeFileSync(path.join(tmp, `20260102T000000Z-${auditKeyId(b)}.key`), b);
    fs.writeFileSync(path.join(tmp, `20260101T000000Z-${auditKeyId(a)}.key`), a);
    fs.writeFileSync(path.join(tmp, `20260103T000000Z-${auditKeyId(a)}.key`), b);
    fs.writeFileSync(path.join(tmp, "README"), "x");
    expect(loadRetiredAuditKeys(tmp).map((k) => k.keyId)).toEqual([auditKeyId(a), auditKeyId(b)]);
  });

  it("a box that never rotated has an empty keyring", () => {
    expect(loadRetiredAuditKeys(path.join(tmp, "nope"))).toEqual([]);
  });
});

describe("POST /api/activity/rotate-key — role and MFA gate", () => {
  function app(role: string, lastMfaAt: Date | null) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).user = { id: "u1", username: "u1", role, lastMfaAt };
      next();
    });
    a.use("/api", createActivityRouter(fakePrisma(chain)));
    return a;
  }

  it("refuses an admin (owner only)", async () => {
    const res = await request(app("admin", new Date())).post("/api/activity/rotate-key");
    expect(res.status).toBe(403);
  });

  it("refuses an owner without a recent MFA re-auth", async () => {
    const res = await request(app("owner", null)).post("/api/activity/rotate-key");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_required");
  });

  it("an owner with recent MFA reaches the rotation (no host helper here → 503)", async () => {
    _initActivityRecorderWithKeysForTests(fakePrisma(chain), [OLD]);
    const res = await request(app("owner", new Date())).post("/api/activity/rotate-key");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("HOST_HELPER_UNAVAILABLE");
    expect(getCurrentAuditKeyId()).toBe(auditKeyId(OLD));
  });
});
