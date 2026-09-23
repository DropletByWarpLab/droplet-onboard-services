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

/**
 * WARP-1157 — a non-2xx answer from the box. `code` is the orchestrator's
 * machine-readable reason (routes/webauthn.ts `WebAuthnErrorCode`), absent on
 * older servers and on generic failures (429, gateway errors).
 */
export class PasskeyServerError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "PasskeyServerError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new PasskeyServerError(
      res.status,
      typeof data.code === "string" ? data.code : null,
      data.error || `Request to ${url} failed`,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>("POST", url, body);
}

// ─── WARP-1157: which addresses can hold a passkey ──────────────────────────

/**
 * Why THIS page can never run a passkey ceremony, or null when it can.
 *   - `insecure_context`: plain http. Browsers hide WebAuthn entirely here, so
 *     this must be checked BEFORE `isPasskeySupported()` — otherwise the page
 *     blames the browser for what is really the connection.
 *   - `ip_address`: an IP is never a valid RP ID, even over https.
 * A certificate warning that was clicked through can't be detected from JS;
 * that case surfaces as a ceremony error (see describePasskeyError).
 */
export type PasskeyOriginProblem = "insecure_context" | "ip_address";

export function passkeyOriginProblem(): PasskeyOriginProblem | null {
  if (typeof window === "undefined") return null;
  if (window.isSecureContext === false) return "insecure_context";
  const host = window.location?.hostname ?? "";
  if (host.includes(":") || host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return "ip_address";
  }
  return null;
}

/** What went wrong, in terms the copy can be honest about. */
export type PasskeyErrorKind =
  | "insecure_context"
  | "ip_address"
  | "certificate"
  | "cancelled"
  | "already_registered"
  | "authenticator_unsupported"
  | "challenge_expired"
  | "verification_failed"
  | "storage_failed"
  | "unavailable"
  | "network"
  | "unknown";

export interface PasskeyErrorView {
  kind: PasskeyErrorKind;
  message: string;
  /** False when the same attempt from the same page can't succeed — the UI
   *  must not offer "try again" for these. */
  retryable: boolean;
}

function errName(err: unknown): string | undefined {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : undefined;
}

function errMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

/** Map an error from the register ceremony, or a passkey-list call, to a kind.
 *  Reads DOMException NAMES and server CODES only; messages are never shown
 *  (they can carry transport detail) and only sniffed for Chrome's
 *  certificate refusal, which has no dedicated name. */
export function classifyPasskeyError(err: unknown): PasskeyErrorKind {
  if (err instanceof PasskeyServerError) {
    switch (err.code) {
      case "origin_unsupported":
        return "ip_address";
      case "challenge_expired":
        return "challenge_expired";
      case "verification_failed":
        return "verification_failed";
      case "already_registered":
        return "already_registered";
      case "storage_failed":
        return "storage_failed";
      case "directory_unavailable":
        return "unavailable";
    }
    return err.status >= 500 || err.status === 429 ? "unavailable" : "unknown";
  }
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(errMessage(err))) {
    return "network";
  }
  // Chrome: "WebAuthn is not supported on sites with TLS certificate errors."
  if (/certificate/i.test(errMessage(err))) return "certificate";
  // @simplewebauthn/browser keeps the DOMException name on its WebAuthnError.
  switch (errName(err) ?? errName((err as { cause?: unknown } | null)?.cause)) {
    case "NotAllowedError":
    case "AbortError":
      return "cancelled";
    case "InvalidStateError":
      return "already_registered";
    case "SecurityError":
      // RP ID doesn't match the page's domain, or the page isn't a secure
      // origin — both are about the address, never fixed by retrying here.
      return passkeyOriginProblem() ?? "insecure_context";
    case "NotSupportedError":
    case "ConstraintError":
      return "authenticator_unsupported";
  }
  return "unknown";
}

const SECURE_ADDRESS_HINT =
  "Open your Droplet at its secure https address from setup and use passkeys there.";

/** Accurate, user-facing copy for a failed passkey action. */
export function describePasskeyError(err: unknown): PasskeyErrorView {
  return passkeyErrorView(classifyPasskeyError(err));
}

/** The copy for one kind — also used directly for an address pre-check, so a
 *  pre-check and a late ceremony failure read the same. */
export function passkeyErrorView(kind: PasskeyErrorKind): PasskeyErrorView {
  switch (kind) {
    case "insecure_context":
      return {
        kind,
        retryable: false,
        message: `Passkeys need a secure connection, and this address doesn't have one. ${SECURE_ADDRESS_HINT}`,
      };
    case "ip_address":
      return {
        kind,
        retryable: false,
        message: `Passkeys only work when you open your Droplet by its name, not by its IP address. ${SECURE_ADDRESS_HINT}`,
      };
    case "certificate":
      return {
        kind,
        retryable: false,
        message:
          "Your browser doesn't trust this connection's certificate, so it won't make passkeys here. " +
          SECURE_ADDRESS_HINT,
      };
    case "cancelled":
      return {
        kind,
        retryable: true,
        message: "The passkey prompt was closed or timed out. Try again when you're ready.",
      };
    case "already_registered":
      return {
        kind,
        retryable: false,
        message: "This device already has a passkey for this Droplet. You can use it to sign in.",
      };
    case "authenticator_unsupported":
      return {
        kind,
        retryable: false,
        message: "This device or security key can't make a passkey your Droplet accepts. Try a different device or key.",
      };
    case "challenge_expired":
      return {
        kind,
        retryable: true,
        message: "The passkey request expired before it finished. Try again.",
      };
    case "verification_failed":
      return {
        kind,
        retryable: false,
        message:
          "Your Droplet couldn't verify that passkey, so it wasn't saved. " +
          "This usually means the address in your browser isn't one your Droplet serves securely. " +
          SECURE_ADDRESS_HINT,
      };
    case "storage_failed":
      return {
        kind,
        retryable: false,
        message:
          "Your Droplet couldn't save the passkey. The problem is on the Droplet, not your device. Check the Health page, then try again later.",
      };
    case "unavailable":
      return {
        kind,
        retryable: true,
        message: "Your Droplet can't manage passkeys right now. Try again in a few minutes.",
      };
    case "network":
      return {
        kind,
        retryable: true,
        message: "We couldn't reach your Droplet. Check that you're on your office network, then try again.",
      };
    case "unknown":
    default:
      return { kind: "unknown", retryable: true, message: "We couldn't add that passkey. Try again." };
  }
}

// ─── WARP-1157: the signed-in user's passkey list ───────────────────────────

export interface PasskeySummary {
  id: string;
  /** Owner-chosen label; null until renamed. */
  name: string | null;
  /** The host this passkey works on; null for passkeys enrolled before it was recorded. */
  rpId: string | null;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const { credentials } = await requestJson<{ credentials: PasskeySummary[] }>(
    "GET",
    "/api/auth/webauthn/credentials",
  );
  return credentials;
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await requestJson("PATCH", `/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, { name });
}

export async function removePasskey(id: string): Promise<void> {
  await requestJson("DELETE", `/api/auth/webauthn/credentials/${encodeURIComponent(id)}`);
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
