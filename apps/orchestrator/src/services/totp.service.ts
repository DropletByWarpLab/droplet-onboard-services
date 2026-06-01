import { generateSecret, generateURI, verify } from "otplib";
import { encryptSecret, decryptSecret } from "./encryption.service.js";

/**
 * TOTP (RFC 6238) second factor for the built-in argon2id directory
 * (ADR-013). This module is the single boundary to the `otplib` vetted
 * library and the only place that ever holds a TOTP secret in plaintext.
 *
 * Secret-at-rest: the per-user TOTP secret is encrypted with the existing
 * aes-256-gcm `encryption.service` (keyed by DEVICE_SECRET_KEY, generated
 * once by scripts/setup.sh). We deliberately reuse that boundary rather
 * than introduce a new key/env var — the architecture rule against new
 * `MATTER_*` vars and the "one secret-at-rest mechanism" posture both
 * point here. `TotpCredential.secretEnc` stores the opaque base64 blob;
 * the plaintext secret never lands in a column or a log line.
 *
 * Verification window: a 6-digit code is accepted within ±1 period (30 s)
 * of the current epoch to tolerate clock skew between the appliance and
 * the authenticator app, matching the AC's "small time-window tolerance".
 * otplib's verify uses a constant-time comparison internally.
 */

/** Shown by the authenticator app as the account issuer. */
export const TOTP_ISSUER = "Droplet";

/** TOTP period in seconds (RFC 6238 default; Google Authenticator value). */
const TOTP_PERIOD_SECONDS = 30;

/**
 * Accept a code that was valid within ±1 period. otplib measures
 * `epochTolerance` in SECONDS, so one period either side is the period
 * length. This is the conservative "small window" — wide enough for
 * real-world phone clock drift, narrow enough that a single code is live
 * for at most ~90 s.
 */
const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

/** A valid TOTP code is exactly six decimal digits. */
const TOTP_CODE_RE = /^\d{6}$/;

export interface TotpEnrollment {
  /** Base32 secret — encrypt before storage, surface once during enroll. */
  secret: string;
  /** otpauth:// URI for the authenticator-app QR. */
  otpauthUri: string;
}

/**
 * Mint a fresh TOTP secret and the matching `otpauth://` enrollment URI.
 *
 * `label` identifies the account inside the authenticator app (we pass the
 * user's email). The returned secret is plaintext — the caller encrypts it
 * via `encryptTotpSecret` before it touches the database and never logs it.
 */
export function generateTotpEnrollment(label: string): TotpEnrollment {
  const secret = generateSecret();
  const otpauthUri = generateURI({
    issuer: TOTP_ISSUER,
    label,
    secret,
    period: TOTP_PERIOD_SECONDS,
  });
  return { secret, otpauthUri };
}

/** Encrypt a plaintext TOTP secret for at-rest storage (aes-256-gcm). */
export function encryptTotpSecret(secret: string): string {
  return encryptSecret(secret);
}

/** Decrypt a `secretEnc` blob produced by {@link encryptTotpSecret}. */
export function decryptTotpSecret(blob: string): string {
  return decryptSecret(blob);
}

/**
 * Verify a 6-digit code against a (plaintext) TOTP secret within the
 * tolerance window. Returns false — never throws — for malformed codes or
 * a corrupt/foreign secret, so a bad row reads as "wrong code" to the
 * caller rather than a 500 (mirrors password.service.verifyPassword).
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
): Promise<boolean> {
  if (!TOTP_CODE_RE.test(code)) return false;
  try {
    const result = await verify({
      secret,
      token: code,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
    });
    return result.valid;
  } catch {
    // Foreign/corrupt secret or library error — treat as an invalid code.
    return false;
  }
}
