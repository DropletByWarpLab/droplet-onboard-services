/**
 * WARP-456 — HMAC-SHA256 signing helper for ActivityRow.
 *
 * The helper is the only thing that touches the private key bytes.
 * Everything else in the activity pipeline takes a signer instance, so
 * we can swap in a TPM-backed implementation later (per AC2: "Helper
 * is pluggable for TPM later").
 *
 * These tests use an in-memory signer constructed from a fixed key so
 * the assertions are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHmacSigner,
  canonicalizeRowContent,
  hashSignature,
  loadAuditKeyFromDisk,
  _setLoggerForTests,
  type ActivityRowContent,
} from "./audit-signing.service.js";

const KEY = Buffer.from("warp-456-test-key-bytes-must-be-long", "utf8");

const sampleContent: ActivityRowContent = {
  at: new Date("2026-05-25T12:00:00.000Z"),
  severity: "ok",
  sourceIcon: "message-square",
  what: "Chat turn completed",
  sub: "Alice • llama3.1",
  kind: "chat",
  refs: { conversationId: "abc-123", messageId: "msg-456" },
  actorType: "user",
  actorId: "uuid-alice",
  schemaVersion: 2,
};

describe("audit-signing.service — canonical content", () => {
  it("canonicalizes a row content object deterministically (keys sorted)", () => {
    const a = canonicalizeRowContent(sampleContent);
    const b = canonicalizeRowContent({
      // intentionally rearranged
      kind: "chat",
      refs: { messageId: "msg-456", conversationId: "abc-123" },
      sub: "Alice • llama3.1",
      actorId: "uuid-alice",
      what: "Chat turn completed",
      sourceIcon: "message-square",
      severity: "ok",
      schemaVersion: 2,
      actorType: "user",
      at: new Date("2026-05-25T12:00:00.000Z"),
    });
    expect(a).toBe(b);
  });

  it("v1 rows canonicalize to the exact legacy 7-key shape (byte-identical)", () => {
    // WARP-181 regression guard: pre-upgrade rows were signed under
    // this exact string — any drift breaks verification of every
    // existing chain in the field.
    const c = canonicalizeRowContent({
      at: new Date("2026-05-25T12:00:00.000Z"),
      severity: "ok",
      sourceIcon: "message-square",
      what: "Chat turn completed",
      sub: "Alice • llama3.1",
      kind: "chat",
      refs: { conversationId: "abc-123", messageId: "msg-456" },
      actorType: null,
      actorId: null,
      schemaVersion: 1,
    });
    expect(c).toBe(
      '{"at":"2026-05-25T12:00:00.000Z","kind":"chat",' +
        '"refs":{"conversationId":"abc-123","messageId":"msg-456"},' +
        '"severity":"ok","sourceIcon":"message-square",' +
        '"sub":"Alice • llama3.1","what":"Chat turn completed"}',
    );
    // Actor keys never leak into the v1 form even if set on the row —
    // a v1 row's actor columns are untrusted decoration, not signed data.
    expect(c).not.toContain("actor");
  });

  it("emits ISO-8601 timestamps so the canonical form is portable", () => {
    const c = canonicalizeRowContent(sampleContent);
    expect(c).toContain('"at":"2026-05-25T12:00:00.000Z"');
  });

  it("includes null for `sub` and `refs` when absent so the hash domain is stable", () => {
    const c = canonicalizeRowContent({
      at: new Date("2026-05-25T12:00:00.000Z"),
      severity: "info",
      sourceIcon: "shield",
      what: "x",
      sub: null,
      kind: "system",
      refs: null,
      actorType: "system",
      actorId: null,
      schemaVersion: 2,
    });
    expect(c).toContain('"sub":null');
    expect(c).toContain('"refs":null');
    expect(c).toContain('"actorId":null');
  });
});

describe("audit-signing.service — HMAC signer", () => {
  it("computes a base64-url signature with no padding", () => {
    const signer = createHmacSigner(KEY);
    const sig = signer.sign(sampleContent, "");
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sig).not.toContain("=");
  });

  it("produces the same signature for the same input twice (determinism)", () => {
    const signer = createHmacSigner(KEY);
    const sig1 = signer.sign(sampleContent, "");
    const sig2 = signer.sign(sampleContent, "");
    expect(sig1).toBe(sig2);
  });

  it("changes the signature when prevSignatureHash changes (chain coupling)", () => {
    const signer = createHmacSigner(KEY);
    const a = signer.sign(sampleContent, "");
    const b = signer.sign(sampleContent, hashSignature("xyz"));
    expect(a).not.toBe(b);
  });

  it("changes the signature when any content field changes (tamper sensitivity)", () => {
    const signer = createHmacSigner(KEY);
    const a = signer.sign(sampleContent, "");
    const b = signer.sign({ ...sampleContent, what: "Chat turn FAILED" }, "");
    expect(a).not.toBe(b);
  });

  it("verifies a signature produced with the same key", () => {
    const signer = createHmacSigner(KEY);
    const sig = signer.sign(sampleContent, "");
    expect(signer.verify(sampleContent, "", sig)).toBe(true);
  });

  it("rejects a forged signature", () => {
    const signer = createHmacSigner(KEY);
    expect(signer.verify(sampleContent, "", "AAAA")).toBe(false);
  });

  it("rejects a signature when the prevSignatureHash is wrong (chain break)", () => {
    const signer = createHmacSigner(KEY);
    const sig = signer.sign(sampleContent, "");
    expect(
      signer.verify(sampleContent, hashSignature("different-prev"), sig),
    ).toBe(false);
  });

  it("rejects a signature when content is mutated (tamper detection)", () => {
    const signer = createHmacSigner(KEY);
    const sig = signer.sign(sampleContent, "");
    expect(
      signer.verify({ ...sampleContent, what: "different" }, "", sig),
    ).toBe(false);
  });

  it("a different key produces a different signature (key isolation)", () => {
    const signer1 = createHmacSigner(KEY);
    const signer2 = createHmacSigner(
      Buffer.from("warp-456-rotated-key-bytes-also-long", "utf8"),
    );
    expect(signer1.sign(sampleContent, "")).not.toBe(
      signer2.sign(sampleContent, ""),
    );
  });

  it("rejects a tiny key (≥32 bytes required for HMAC-SHA256 strength)", () => {
    expect(() => createHmacSigner(Buffer.from("too-short", "utf8"))).toThrow(
      /key must be at least 32 bytes/i,
    );
  });
});

describe("audit-signing.service — loadAuditKeyFromDisk (WARP-476)", () => {
  // 32 raw bytes — same length the on-disk file would have. Two distinct
  // 32-byte buffers so we can deterministically detect which one wins.
  const DISK_BYTES = Buffer.alloc(32, 0xa1);
  const ENV_BYTES = Buffer.alloc(32, 0x5e);
  const ENV_BYTES_BASE64 = ENV_BYTES.toString("base64");
  const DISK_BYTES_BASE64 = DISK_BYTES.toString("base64");

  let dir: string;
  let diskPath: string;
  let warnSpy: ReturnType<typeof vi.fn>;
  const originalEnvKey = process.env.AUDIT_SIGNING_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "warp-476-audit-key-"));
    diskPath = path.join(dir, "audit.key");
    delete process.env.AUDIT_SIGNING_KEY;
    delete process.env.NODE_ENV;
    warnSpy = vi.fn();
    _setLoggerForTests({ warn: warnSpy });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnvKey === undefined) delete process.env.AUDIT_SIGNING_KEY;
    else process.env.AUDIT_SIGNING_KEY = originalEnvKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    _setLoggerForTests(null);
  });

  // (a) disk-only path → uses disk key
  it("uses the disk key when the env var is unset (disk-only path)", () => {
    writeFileSync(diskPath, DISK_BYTES);
    const loaded = loadAuditKeyFromDisk(diskPath);
    expect(loaded.equals(DISK_BYTES)).toBe(true);
  });

  // (b) env-only path with no disk → uses env key
  it("falls back to the env var when the disk file is absent (env-only path)", () => {
    // diskPath intentionally not written
    process.env.AUDIT_SIGNING_KEY = ENV_BYTES_BASE64;
    const loaded = loadAuditKeyFromDisk(diskPath);
    expect(loaded.equals(ENV_BYTES)).toBe(true);
  });

  // (c) both-set, same value → uses disk, no warning
  it("uses disk and does not warn when env matches disk byte-for-byte", () => {
    writeFileSync(diskPath, DISK_BYTES);
    process.env.AUDIT_SIGNING_KEY = DISK_BYTES_BASE64;
    process.env.NODE_ENV = "production";

    const loaded = loadAuditKeyFromDisk(diskPath);

    expect(loaded.equals(DISK_BYTES)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // (d) both-set, different value, production → throws with clear message
  it("throws a FATAL error in production when env disagrees with disk", () => {
    writeFileSync(diskPath, DISK_BYTES);
    process.env.AUDIT_SIGNING_KEY = ENV_BYTES_BASE64;
    process.env.NODE_ENV = "production";

    expect(() => loadAuditKeyFromDisk(diskPath)).toThrow(
      /FATAL.*AUDIT_SIGNING_KEY.*conflicts.*audit\.key/i,
    );
  });

  // (e) both-set, different value, development → uses env, logs warn
  it("uses env override and logs a warning in development when env disagrees with disk", () => {
    writeFileSync(diskPath, DISK_BYTES);
    process.env.AUDIT_SIGNING_KEY = ENV_BYTES_BASE64;
    process.env.NODE_ENV = "development";

    const loaded = loadAuditKeyFromDisk(diskPath);

    expect(loaded.equals(ENV_BYTES)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Structured-log shape: first arg is the context object, second is the message.
    const [ctx, msg] = warnSpy.mock.calls[0] as [
      { diskPath: string; envOverride: boolean },
      string,
    ];
    expect(ctx.diskPath).toBe(diskPath);
    expect(ctx.envOverride).toBe(true);
    expect(msg).toMatch(/AUDIT_SIGNING_KEY.*differs.*disk/i);
  });
});

describe("audit-signing.service — hashSignature", () => {
  it("hashes the empty string to a stable base64-url digest", () => {
    const h = hashSignature("");
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 of "" base64-url: 47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU
    expect(h).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it("is deterministic and produces different hashes for different inputs", () => {
    expect(hashSignature("abc")).toBe(hashSignature("abc"));
    expect(hashSignature("abc")).not.toBe(hashSignature("abd"));
  });
});
