/**
 * WARP-1474 (ADR-030, epic WARP-1382) — the box-side foundation for the
 * "scan a QR on the dashboard to link a device to the WireGuard overlay" flow.
 *
 * This module holds the pure, side-effect-free substrate the /api/vpn/overlay
 * link-token + by-token + pending-enrollment routes build on:
 *   - opaque link-token minting + sha256 hashing (plaintext is NEVER persisted;
 *     only the hash is stored),
 *   - boundary validators for the untrusted by-token body (WireGuard key regex,
 *     label charset, P-256 SPKI parse within a strict byte cap),
 *   - the client proof-of-possession (PoP) message + ECDSA-P256 verify used by
 *     the unauthenticated status endpoint,
 *   - a small deterministic fixed-window rate limiter (injected clock) that
 *     backs the mint / by-token DoS caps.
 *
 * Crypto reuse (hard rule): the sign-key fingerprint is `sha256(pem)` computed
 * with the SAME helper the box→HQ vouch uses (`sha256Hex` in
 * overlay-connect.service), so the box vouch, the stored `boundSignFp`, and
 * HQ's recompute stay byte-identical. There is NO second signing scheme — the
 * client PoP verifies against the ADR-020 ECDSA-P256 substrate.
 */
import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { sha256Hex } from "./overlay-connect.service.js";

// --- Tunables (constants, not env vars — no new knobs on the wire) ----------

/** Link-token time-to-live. ~5 minutes: long enough to walk a phone to the QR,
 *  short enough that a leaked token is useless within a coffee break. */
export const OVERLAY_LINK_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Strict upper bound on the `sign_public_key_pem` byte length. A P-256 SPKI
 *  PEM is ~178 bytes; this cap rejects an oversized body before any parse work
 *  so a client can't hand us a multi-megabyte "PEM" to chew on. */
export const MAX_SIGN_PEM_BYTES = 1000;

/** Hard cap on concurrently-active QR-enrolled overlay devices per box. The
 *  approve path counts approved enrollments and refuses over this many — the
 *  real backstop against an owner (or a compromised session) approving an
 *  unbounded fleet of remote peers. */
export const MAX_ACTIVE_QR_OVERLAY_DEVICES = 20;

/** Domain-prefixed, versioned PoP message the status endpoint verifies. */
export const STATUS_POP_PREFIX = "droplet-overlay-enroll-status:v1:";
/**
 * WARP-1757 — the profile fetch signs a DIFFERENT domain-prefixed message than
 * the status poll. Domain separation is the point: a status signature is a
 * coarse read primitive, a profile signature returns the box's server key,
 * tunnel address and endpoint candidates. One must never be replayable as the
 * other, so they can never share a prefix.
 */
export const PROFILE_POP_PREFIX = "droplet-overlay-enroll-profile:v1:";

// --- Link-token minting -----------------------------------------------------

/** WireGuard public keys are base64 X25519: 43 chars + '='. Same regex the
 *  owner-JWT enroll route pins so both boundaries agree. */
export const WG_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Mint an opaque link token. 32 random bytes (256-bit) rendered base64url
 * (43 chars, no padding). Returns the plaintext token (surfaced to the owner
 * ONCE) and its sha256 hex hash (the ONLY value persisted / comparable).
 */
export function generateLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/** Stable lowercase-hex sha256 of a token. Same primitive as the box vouch's
 *  fingerprinting so hashing is consistent across the codebase. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

// --- Boundary validators ----------------------------------------------------

/**
 * Human label for the device. Trimmed, 1..64 chars, restricted to a safe
 * printable charset (letters, digits, space, and `.-_'`). Stored + rendered as
 * TEXT only; the charset restriction keeps angle brackets / control bytes out
 * of the dashboard render path defensively (the render layer escapes too, but
 * the boundary refuses the payload outright).
 */
export const overlayLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N} .\-_']+$/u, "label contains unsupported characters");

/**
 * Parse the client's `sign_public_key_pem` as a well-formed P-256 (prime256v1)
 * SubjectPublicKeyInfo, within the strict byte cap. Returns a discriminated
 * result rather than throwing so the route can map a failure to an audited 400
 * without a try/catch dance. The caller stores the EXACT validated PEM bytes
 * un-trimmed so `sha256(pem)` stays byte-identical to the box vouch + HQ
 * recompute.
 */
export function parseP256Spki(
  pem: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof pem !== "string" || pem.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Buffer.byteLength(pem, "utf8") > MAX_SIGN_PEM_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  let key;
  try {
    key = createPublicKey({ key: pem, format: "pem", type: "spki" });
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (key.asymmetricKeyType !== "ec") {
    return { ok: false, reason: "not-ec" };
  }
  // Node exposes the curve via asymmetricKeyDetails on modern runtimes; the
  // JWK export is the portable fallback (crv === "P-256").
  const namedCurve =
    key.asymmetricKeyDetails?.namedCurve ??
    (() => {
      try {
        return key.export({ format: "jwk" }).crv;
      } catch {
        return undefined;
      }
    })();
  if (namedCurve !== "prime256v1" && namedCurve !== "P-256") {
    return { ok: false, reason: "wrong-curve" };
  }
  return { ok: true };
}

// --- Fingerprints -----------------------------------------------------------

/** Full sha256(pem) hex — the sign-key fingerprint. Byte-identical to the box
 *  vouch grant's fingerprint (both go through `sha256Hex`). */
export function signKeyFingerprint(pem: string): string {
  return sha256Hex(pem);
}

/** First 8 hex chars of sha256(pem) — the short fingerprint the owner sees on
 *  the pending-enrollments list to eyeball-match the device. */
export function fingerprintShort(pem: string): string {
  return signKeyFingerprint(pem).slice(0, 8);
}

// --- Status proof-of-possession --------------------------------------------

/** `droplet-overlay-enroll-status:v1:<pending_id>` — the ASCII bytes the client
 *  signs with its sign key to prove it owns the pending enrollment it's polling
 *  (the `pending_id` is unguessable; the PoP stops anyone who guesses/leaks it
 *  from reading even the coarse state). */
export function buildStatusPopMessage(pendingId: string): string {
  return `${STATUS_POP_PREFIX}${pendingId}`;
}

/**
 * Verify the `X-Overlay-PoP` header: a base64 ECDSA-P256 signature over
 * `buildStatusPopMessage(pendingId)`, checked against the pending row's stored
 * `sign_public_key_pem`. Accepts BOTH raw r||s (WebCrypto / most mobile crypto
 * libs) and DER encodings for client interop. Never throws — any malformed
 * input returns false (fail-closed).
 */
export function verifyStatusPop(
  pem: string,
  pendingId: string,
  sigBase64: string,
): boolean {
  return verifyPopOverMessage(pem, buildStatusPopMessage(pendingId), sigBase64);
}

/** `droplet-overlay-enroll-profile:v1:<pending_id>` — WARP-1757. The bytes a
 *  client signs to fetch its tunnel profile. Distinct prefix from the status
 *  poll so neither signature can be replayed as the other. */
export function buildProfilePopMessage(pendingId: string): string {
  return `${PROFILE_POP_PREFIX}${pendingId}`;
}

/** WARP-1757 — the profile-fetch counterpart of {@link verifyStatusPop}. */
export function verifyProfilePop(
  pem: string,
  pendingId: string,
  sigBase64: string,
): boolean {
  return verifyPopOverMessage(pem, buildProfilePopMessage(pendingId), sigBase64);
}

/**
 * Shared ECDSA-P256 verification over an arbitrary domain-prefixed message.
 * Accepts BOTH raw r||s (WebCrypto / most mobile crypto libs) and DER for
 * client interop. Never throws — any malformed input returns false
 * (fail-closed). Callers supply the message so the domain prefix, and thus what
 * a given signature authorizes, stays explicit at every call site.
 */
function verifyPopOverMessage(
  pem: string,
  message: string,
  sigBase64: string,
): boolean {
  if (!sigBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sigBase64.trim())) {
    return false;
  }
  let key;
  try {
    key = createPublicKey({ key: pem, format: "pem", type: "spki" });
  } catch {
    return false;
  }
  const data = Buffer.from(message, "ascii");
  const sig = Buffer.from(sigBase64, "base64");
  if (sig.length === 0) return false;
  for (const dsaEncoding of ["ieee-p1363", "der"] as const) {
    try {
      if (cryptoVerify("sha256", data, { key, dsaEncoding }, sig)) return true;
    } catch {
      // wrong encoding for this attempt — try the next.
    }
  }
  return false;
}

// --- Fixed-window rate limiter ----------------------------------------------

/**
 * Deterministic in-memory fixed-window limiter. Keyed by an opaque string; the
 * caller derives per-owner / per-IP / per-token / global keys. The clock is
 * injected so tests are deterministic and production passes `Date.now`.
 *
 * Fixed-window (not sliding) is deliberate: it's O(1) per check, needs no
 * per-hit history, and a burst at a window boundary is an acceptable tradeoff
 * for a DoS backstop whose real job is to cap sustained abuse, not to meter
 * perfectly.
 *
 * Memory (SEND-BACK #1): the by-token path keys buckets on
 * `sha256(attacker-supplied token)`, so distinct redeem attempts mint distinct
 * keys. On an always-on appliance an un-evicted Map would grow without bound.
 * `check()` therefore performs LAZY, event-driven eviction — no background loop
 * (rule: no `while(true)`): each call opportunistically sweeps fully-elapsed
 * buckets (gated so the hot path stays O(1) in the common case), and a hard
 * `maxBuckets` safety cap bounds worst-case memory even within a single window.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<
    string,
    { windowStart: number; windowMs: number; count: number }
  >();
  private readonly now: () => number;
  private readonly maxBuckets: number;
  /** Last wall-clock at which we swept expired buckets. `-Infinity` forces the
   *  first check to sweep (over an empty/tiny Map — cheap). */
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(now: () => number = () => Date.now(), maxBuckets = 10_000) {
    this.now = now;
    this.maxBuckets = maxBuckets;
  }

  /** Number of live buckets. Exposed read-only so tests can prove eviction. */
  get size(): number {
    return this.buckets.size;
  }

  /** Returns true if the hit is ALLOWED (and records it), false if it would
   *  exceed `limit` within the current `windowMs` window. */
  check(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    // Lazy eviction: sweep at most once per `windowMs` (a bucket can only go
    // stale after a full window), OR immediately when the Map hits the safety
    // cap. Cheap-gated so the steady state stays O(1) per check.
    if (this.buckets.size >= this.maxBuckets || t - this.lastSweep >= windowMs) {
      this.sweep(t);
    }
    const bucket = this.buckets.get(key);
    if (!bucket || t - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { windowStart: t, windowMs, count: 1 });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  /** Drop every bucket whose window has fully elapsed; if an adversary created
   *  more than `maxBuckets` still-live buckets inside one window, evict the
   *  oldest until back under the cap (bounded memory beats perfect accounting
   *  for a DoS backstop). Single pass, no loop over time (event-driven). */
  private sweep(t: number): void {
    for (const [k, b] of this.buckets) {
      if (t - b.windowStart >= b.windowMs) this.buckets.delete(k);
    }
    this.lastSweep = t;
    if (this.buckets.size >= this.maxBuckets) {
      const oldestFirst = [...this.buckets.entries()].sort(
        (a, b) => a[1].windowStart - b[1].windowStart,
      );
      for (const [k] of oldestFirst) {
        if (this.buckets.size < this.maxBuckets) break;
        this.buckets.delete(k);
      }
    }
  }
}
