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
import { describe, it, expect } from "vitest";
import {
  createHmacSigner,
  canonicalizeRowContent,
  hashSignature,
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
};

describe("audit-signing.service — canonical content", () => {
  it("canonicalizes a row content object deterministically (keys sorted)", () => {
    const a = canonicalizeRowContent(sampleContent);
    const b = canonicalizeRowContent({
      // intentionally rearranged
      kind: "chat",
      refs: { messageId: "msg-456", conversationId: "abc-123" },
      sub: "Alice • llama3.1",
      what: "Chat turn completed",
      sourceIcon: "message-square",
      severity: "ok",
      at: new Date("2026-05-25T12:00:00.000Z"),
    });
    expect(a).toBe(b);
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
    });
    expect(c).toContain('"sub":null');
    expect(c).toContain('"refs":null');
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
