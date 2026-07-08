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
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
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
 * The passwordless sign-in ceremony, split into its three constituent steps so
 * the dedicated `/login/passkey` approval page (WARP-1054) can drive a state
 * machine around them — showing "getting ready" during the options round-trip,
 * "approve this sign-in" while the browser sheet is up, and "almost there"
 * during verification. `signInWithPasskey()` below composes them for any caller
 * that just wants the whole thing in one await (and for the existing wiring
 * test). Keeping the wire calls here (not in the page) means every WebAuthn
 * concern stays in this one module.
 */

/** Step 1 — fetch assertion options (the single-use server challenge). The raw
 *  options are returned so the caller can read `options.timeout` for its own
 *  timeout heuristic. */
export async function getPasskeyAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return postJson<PublicKeyCredentialRequestOptionsJSON>(
    "/api/auth/webauthn/authenticate/options",
  );
}

/** Step 2 — run the browser ceremony (this is what raises the native passkey
 *  sheet / QR). Rejects with a `NotAllowedError` on dismiss/timeout/no-match
 *  (the WebAuthn spec keeps those three deliberately indistinguishable), or an
 *  `AbortError` when {@link cancelPasskeyCeremony} is called. */
export async function runPasskeyAuthenticationCeremony(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

/** Step 3 — post the assertion back. On success the server has set the session
 *  cookie; we return the user profile so the caller can hydrate the auth context
 *  exactly like a password login. Throws (via postJson) on a non-2xx verify. */
export async function verifyPasskeyAuthentication(
  assertion: AuthenticationResponseJSON,
): Promise<AuthUser> {
  const result = await postJson<{ user: AuthUser }>(
    "/api/auth/webauthn/authenticate/verify",
    { response: assertion },
  );
  return result.user;
}

/**
 * Abort an in-flight passkey ceremony (the "Cancel" action on the approval
 * page, and unmount cleanup). @simplewebauthn/browser@13 routes every ceremony
 * through a singleton abort controller; `cancelCeremony()` aborts the live
 * `navigator.credentials.get()` so it doesn't linger or reject after the page
 * has navigated away. Safe to call when no ceremony is active (it no-ops).
 */
export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * Sign in with a passkey (passwordless), start to finish. Composes the three
 * steps above. On success the server has set the session cookie; we return the
 * user profile so the caller can hydrate the auth context exactly like a
 * password login.
 */
export async function signInWithPasskey(): Promise<AuthUser> {
  const options = await getPasskeyAuthenticationOptions();
  const assertion = await runPasskeyAuthenticationCeremony(options);
  return verifyPasskeyAuthentication(assertion);
}
