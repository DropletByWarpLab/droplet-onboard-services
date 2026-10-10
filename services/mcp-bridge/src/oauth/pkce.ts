/** WARP-2401 — PKCE (RFC 7636), S256 only. There is no "plain" and no way to ask for it. */
import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes → 43 base64url characters, the RFC's minimum length. */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** RFC 7636 §4.1: 43 to 128 unreserved characters. Bounds a verifier that
 *  arrives on the wire. */
export function isValidVerifier(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}
