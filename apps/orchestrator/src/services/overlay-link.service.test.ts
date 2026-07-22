import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  generateLinkToken,
  hashToken,
  WG_PUBLIC_KEY_RE,
  overlayLabelSchema,
  parseP256Spki,
  MAX_SIGN_PEM_BYTES,
  buildStatusPopMessage,
  verifyStatusPop,
  signKeyFingerprint,
  fingerprintShort,
  FixedWindowRateLimiter,
} from "./overlay-link.service.js";
import { sha256Hex } from "./overlay-connect.service.js";

// A real P-256 SPKI key + a signer, so the PoP tests exercise Node crypto for
// real rather than a stub. Exported as PEM (SubjectPublicKeyInfo).
function p256KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

describe("overlay-link.service - token minting", () => {
  it("generates a >=256-bit base64url token + its sha256(hex) hash", () => {
    const { token, tokenHash } = generateLinkToken();
    // base64url, no padding, 43 chars = 32 bytes = 256 bits.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(sha256Hex(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a token across mints (opaque randomness)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateLinkToken().token);
    expect(seen.size).toBe(200);
  });

  it("hashToken is a stable lowercase-hex sha256 matching the box vouch helper", () => {
    expect(hashToken("hello")).toBe(sha256Hex("hello"));
  });
});

describe("overlay-link.service - boundary validators", () => {
  it("accepts a canonical WireGuard public key and rejects malformed ones", () => {
    expect(WG_PUBLIC_KEY_RE.test("A".repeat(43) + "=")).toBe(true);
    expect(WG_PUBLIC_KEY_RE.test("not-a-key")).toBe(false);
    expect(WG_PUBLIC_KEY_RE.test("A".repeat(44) + "=")).toBe(false);
    expect(WG_PUBLIC_KEY_RE.test("A".repeat(43))).toBe(false);
  });

  it("labels: trims, caps at 64, restricts the charset (rendered as TEXT)", () => {
    // Letters, digits, spaces, apostrophes, dots, dashes, underscores are OK.
    expect(overlayLabelSchema.safeParse("Alice's iPhone 13").success).toBe(true);
    expect(overlayLabelSchema.safeParse("Living Room TV").success).toBe(true);
    expect(overlayLabelSchema.safeParse("").success).toBe(false);
    expect(overlayLabelSchema.safeParse("x".repeat(65)).success).toBe(false);
    // Angle brackets, pipes, and control chars are refused at the boundary so
    // they never reach the dashboard render path.
    expect(overlayLabelSchema.safeParse("<script>alert(1)</script>").success).toBe(false);
    expect(overlayLabelSchema.safeParse("pipe|char").success).toBe(false);
    expect(overlayLabelSchema.safeParse("ctrlbell").success).toBe(false);
  });

  it("parses a well-formed P-256 SPKI PEM within the byte cap", () => {
    const { pem } = p256KeyPair();
    expect(parseP256Spki(pem).ok).toBe(true);
  });

  it("rejects a PEM over the strict byte cap", () => {
    const oversized =
      "-----BEGIN PUBLIC KEY-----\n" +
      "A".repeat(MAX_SIGN_PEM_BYTES + 10) +
      "\n-----END PUBLIC KEY-----\n";
    const res = parseP256Spki(oversized);
    expect(res.ok).toBe(false);
  });

  it("rejects a non-P-256 key (wrong curve) and garbage bytes", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const p384 = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(parseP256Spki(p384).ok).toBe(false);
    expect(parseP256Spki("-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----").ok).toBe(false);
    expect(parseP256Spki("").ok).toBe(false);
  });
});

describe("overlay-link.service - fingerprints", () => {
  it("signKeyFingerprint == sha256(pem) hex; fingerprint_short == first 8 hex", () => {
    const { pem } = p256KeyPair();
    const fp = signKeyFingerprint(pem);
    expect(fp).toBe(sha256Hex(pem));
    expect(fingerprintShort(pem)).toBe(fp.slice(0, 8));
    expect(fingerprintShort(pem)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("overlay-link.service - status proof-of-possession", () => {
  it("builds the exact ASCII PoP message", () => {
    expect(buildStatusPopMessage("pend-123")).toBe(
      "droplet-overlay-enroll-status:v1:pend-123",
    );
  });

  it("verifies a valid ECDSA-P256 signature over the message", () => {
    const { pem, privateKey } = p256KeyPair();
    const msg = buildStatusPopMessage("pend-abc");
    // WebCrypto-style raw r||s (ieee-p1363) signature.
    const sig = cryptoSign("sha256", Buffer.from(msg, "ascii"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    expect(verifyStatusPop(pem, "pend-abc", sig.toString("base64"))).toBe(true);
  });

  it("also accepts a DER-encoded signature (client interop)", () => {
    const { pem, privateKey } = p256KeyPair();
    const msg = buildStatusPopMessage("pend-der");
    const sig = cryptoSign("sha256", Buffer.from(msg, "ascii"), {
      key: privateKey,
      dsaEncoding: "der",
    });
    expect(verifyStatusPop(pem, "pend-der", sig.toString("base64"))).toBe(true);
  });

  it("rejects a signature by a different key", () => {
    const { pem } = p256KeyPair();
    const other = p256KeyPair();
    const msg = buildStatusPopMessage("pend-x");
    const sig = cryptoSign("sha256", Buffer.from(msg, "ascii"), {
      key: other.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    expect(verifyStatusPop(pem, "pend-x", sig.toString("base64"))).toBe(false);
  });

  it("rejects a signature over a DIFFERENT pending id (no cross-id replay)", () => {
    const { pem, privateKey } = p256KeyPair();
    const sig = cryptoSign("sha256", Buffer.from(buildStatusPopMessage("pend-1"), "ascii"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    expect(verifyStatusPop(pem, "pend-2", sig.toString("base64"))).toBe(false);
  });

  it("rejects malformed base64 / empty signatures without throwing", () => {
    const { pem } = p256KeyPair();
    expect(verifyStatusPop(pem, "pend-1", "!!!not-base64!!!")).toBe(false);
    expect(verifyStatusPop(pem, "pend-1", "")).toBe(false);
  });
});

describe("overlay-link.service - fixed-window rate limiter", () => {
  it("allows up to the limit inside a window, then blocks", () => {
    let t = 1_000_000;
    const rl = new FixedWindowRateLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(rl.check("k", 3, 60_000)).toBe(true);
    expect(rl.check("k", 3, 60_000)).toBe(false);
  });

  it("independent keys don't share a bucket", () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(() => t);
    expect(rl.check("a", 1, 1000)).toBe(true);
    expect(rl.check("a", 1, 1000)).toBe(false);
    expect(rl.check("b", 1, 1000)).toBe(true);
  });

  it("refills after the window elapses", () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(() => t);
    expect(rl.check("k", 1, 1000)).toBe(true);
    expect(rl.check("k", 1, 1000)).toBe(false);
    t = 1001;
    expect(rl.check("k", 1, 1000)).toBe(true);
  });

  // SEND-BACK #1 — the limiter is keyed by sha256(attacker-supplied token) on an
  // always-on appliance, so without eviction the bucket Map grows unbounded.
  it("prunes fully-elapsed buckets on a later check (Map shrinks)", () => {
    let t = 1_000_000;
    const rl = new FixedWindowRateLimiter(() => t);
    // Create 200 distinct buckets inside window 1.
    for (let i = 0; i < 200; i++) rl.check(`k${i}`, 5, 1000);
    expect(rl.size).toBe(200);
    // Advance PAST the window (and the sweep cadence) — the next check must
    // lazily evict the now-stale buckets rather than let them accumulate.
    t += 10_000;
    rl.check("trigger", 5, 1000);
    // Only the freshly-created "trigger" bucket should remain.
    expect(rl.size).toBeLessThan(200);
    expect(rl.size).toBe(1);
  });

  it("still counts a live bucket after a sweep evicts a stale sibling", () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(() => t);
    rl.check("stale", 5, 1000); // window 1
    t = 5_000; // "stale" is now fully elapsed
    // "live" gets created fresh; the sweep drops "stale" but must not touch
    // "live"'s brand-new count.
    expect(rl.check("live", 1, 1000)).toBe(true);
    expect(rl.check("live", 1, 1000)).toBe(false); // its own limit still enforced
    expect(rl.size).toBe(1); // "stale" evicted, only "live" remains
  });

  it("enforces a hard max-bucket safety cap even within one window", () => {
    let t = 0;
    const rl = new FixedWindowRateLimiter(() => t, 50);
    // Flood distinct keys inside a single window — memory must stay bounded by
    // the cap rather than growing with the (attacker-controlled) key cardinality.
    for (let i = 0; i < 500; i++) rl.check(`flood${i}`, 5, 60_000);
    expect(rl.size).toBeLessThanOrEqual(50);
  });
});
