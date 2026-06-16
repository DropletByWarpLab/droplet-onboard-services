/**
 * PR #377 (WARP-___) — dashboard WebAuthn / passkey client helpers.
 *
 * Thin wrappers over @simplewebauthn/browser that drive the four orchestrator
 * endpoints. The browser library owns the navigator.credentials ceremony; we
 * own the option-fetch / verify round-trips. All requests go through authFetch
 * so the session cookie rides along (registration is a protected route) and a
 * 401 triggers the shared refresh/redirect path.
 */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { authFetch } from "./auth";
import type { AuthUser } from "./auth";

/** True when the current browser exposes the WebAuthn API at all. Used to hide
 *  the passkey affordances on browsers that can't run the ceremony. */
export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn();
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request to ${url} failed`);
  }
  return res.json() as Promise<T>;
}

/**
 * Enrol a passkey for the signed-in user. Fetches creation options, runs the
 * registration ceremony (the OS/browser prompts for the platform authenticator
 * or a roaming key), and posts the attestation back for verification. Resolves
 * on success; throws with a usable message otherwise.
 */
export async function registerPasskey(): Promise<void> {
  const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
    "/api/auth/webauthn/register/options",
  );
  const attestation = await startRegistration({ optionsJSON: options });
  const result = await postJson<{ verified: boolean }>(
    "/api/auth/webauthn/register/verify",
    { response: attestation },
  );
  if (!result.verified) {
    throw new Error("Passkey could not be registered");
  }
}

/**
 * Sign in with a passkey (passwordless). Fetches assertion options, runs the
 * authentication ceremony, and posts the assertion back. On success the server
 * has set the session cookie; we return the user profile so the caller can
 * hydrate the auth context exactly like a password login.
 */
export async function signInWithPasskey(): Promise<AuthUser> {
  const options = await postJson<PublicKeyCredentialRequestOptionsJSON>(
    "/api/auth/webauthn/authenticate/options",
  );
  const assertion = await startAuthentication({ optionsJSON: options });
  const result = await postJson<{ user: AuthUser }>(
    "/api/auth/webauthn/authenticate/verify",
    { response: assertion },
  );
  return result.user;
}
