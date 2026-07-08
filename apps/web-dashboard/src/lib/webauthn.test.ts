/**
 * PR #377 (WARP-___) — dashboard WebAuthn client helpers.
 *
 * Thin wrappers over @simplewebauthn/browser that talk to the four
 * orchestrator endpoints. Tested with the browser ceremony mocked (no real
 * authenticator in jsdom) so we assert the request/response wiring:
 *
 *   registerPasskey: GET options (POST /register/options) -> startRegistration
 *     -> POST /register/verify; resolves on { verified: true }, throws on
 *     verified:false.
 *   signInWithPasskey: POST /authenticate/options -> startAuthentication ->
 *     POST /authenticate/verify; resolves the returned user on success.
 *   isPasskeySupported: proxies browserSupportsWebAuthn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const startRegistration = vi.fn();
const startAuthentication = vi.fn();
const browserSupportsWebAuthn = vi.fn();
const webAuthnCancelCeremony = vi.fn();
vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (...a: unknown[]) => startRegistration(...a),
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
  browserSupportsWebAuthn: (...a: unknown[]) => browserSupportsWebAuthn(...a),
  WebAuthnAbortService: {
    cancelCeremony: (...a: unknown[]) => webAuthnCancelCeremony(...a),
  },
}));

// authFetch — assert it's used (credentials: same-origin attaches the cookie).
const authFetch = vi.fn();
vi.mock("./auth", () => ({
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import {
  registerPasskey,
  signInWithPasskey,
  isPasskeySupported,
  getPasskeyAuthenticationOptions,
  runPasskeyAuthenticationCeremony,
  verifyPasskeyAuthentication,
  cancelPasskeyCeremony,
} from "./webauthn";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerPasskey", () => {
  it("fetches options, runs the ceremony, posts the attestation, resolves on verified", async () => {
    authFetch
      .mockResolvedValueOnce(jsonResponse({ challenge: "c", rp: { id: "droplet.local" } })) // options
      .mockResolvedValueOnce(jsonResponse({ verified: true })); // verify
    startRegistration.mockResolvedValue({ id: "new-cred", response: {} });

    await expect(registerPasskey()).resolves.toBeUndefined();

    expect(authFetch).toHaveBeenNthCalledWith(
      1,
      "/api/auth/webauthn/register/options",
      expect.objectContaining({ method: "POST" }),
    );
    // The library ceremony was driven with the server options.
    expect(startRegistration).toHaveBeenCalledTimes(1);
    // The attestation was posted back under { response }.
    const [, verifyInit] = authFetch.mock.calls[1]!;
    expect(authFetch.mock.calls[1]![0]).toBe("/api/auth/webauthn/register/verify");
    expect(JSON.parse((verifyInit as RequestInit).body as string)).toEqual({
      response: { id: "new-cred", response: {} },
    });
  });

  it("throws when the server reports verified:false", async () => {
    authFetch
      .mockResolvedValueOnce(jsonResponse({ challenge: "c" }))
      .mockResolvedValueOnce(jsonResponse({ verified: false }));
    startRegistration.mockResolvedValue({ id: "x", response: {} });

    await expect(registerPasskey()).rejects.toThrow();
  });

  it("throws when fetching options fails (e.g. not signed in)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ error: "Not authenticated" }, false, 401));
    await expect(registerPasskey()).rejects.toThrow();
    expect(startRegistration).not.toHaveBeenCalled();
  });
});

describe("signInWithPasskey", () => {
  it("fetches options, runs the ceremony, posts the assertion, resolves the user", async () => {
    const user = { id: "u-1", username: "stefan", displayName: "Stefan", role: "owner" as const };
    authFetch
      .mockResolvedValueOnce(jsonResponse({ challenge: "c", rpId: "droplet.local" })) // options
      .mockResolvedValueOnce(jsonResponse({ user })); // verify
    startAuthentication.mockResolvedValue({ id: "cred", response: {} });

    await expect(signInWithPasskey()).resolves.toEqual(user);

    expect(authFetch.mock.calls[0]![0]).toBe("/api/auth/webauthn/authenticate/options");
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    expect(authFetch.mock.calls[1]![0]).toBe("/api/auth/webauthn/authenticate/verify");
  });

  it("throws on a failed assertion (401 from verify)", async () => {
    authFetch
      .mockResolvedValueOnce(jsonResponse({ challenge: "c" }))
      .mockResolvedValueOnce(jsonResponse({ error: "Invalid credentials" }, false, 401));
    startAuthentication.mockResolvedValue({ id: "cred", response: {} });

    await expect(signInWithPasskey()).rejects.toThrow();
  });
});

describe("isPasskeySupported", () => {
  it("proxies browserSupportsWebAuthn", () => {
    browserSupportsWebAuthn.mockReturnValue(true);
    expect(isPasskeySupported()).toBe(true);
    browserSupportsWebAuthn.mockReturnValue(false);
    expect(isPasskeySupported()).toBe(false);
  });
});

// WARP-1054 — the constituent steps the approval page drives individually.
describe("passkey authentication steps (WARP-1054)", () => {
  it("getPasskeyAuthenticationOptions POSTs the options endpoint and returns the raw options", async () => {
    const options = { challenge: "c", timeout: 60_000, rpId: "droplet.local" };
    authFetch.mockResolvedValueOnce(jsonResponse(options));

    await expect(getPasskeyAuthenticationOptions()).resolves.toEqual(options);
    expect(authFetch).toHaveBeenCalledWith(
      "/api/auth/webauthn/authenticate/options",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("runPasskeyAuthenticationCeremony drives startAuthentication with the options", async () => {
    const options = { challenge: "c" };
    startAuthentication.mockResolvedValueOnce({ id: "cred", response: {} });

    await expect(
      runPasskeyAuthenticationCeremony(options as never),
    ).resolves.toEqual({ id: "cred", response: {} });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
  });

  it("verifyPasskeyAuthentication POSTs the assertion and returns the user", async () => {
    const user = { id: "u-1", username: "stefan", displayName: "Stefan", role: "owner" as const };
    authFetch.mockResolvedValueOnce(jsonResponse({ user }));
    const assertion = { id: "cred", response: {} };

    await expect(verifyPasskeyAuthentication(assertion as never)).resolves.toEqual(user);
    const [url, init] = authFetch.mock.calls[0]!;
    expect(url).toBe("/api/auth/webauthn/authenticate/verify");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ response: assertion });
  });

  it("verifyPasskeyAuthentication throws on a non-2xx verify (server rejection)", async () => {
    authFetch.mockResolvedValueOnce(jsonResponse({ error: "Invalid credentials" }, false, 401));
    await expect(verifyPasskeyAuthentication({ id: "x" } as never)).rejects.toThrow();
  });

  it("cancelPasskeyCeremony delegates to WebAuthnAbortService.cancelCeremony", () => {
    cancelPasskeyCeremony();
    expect(webAuthnCancelCeremony).toHaveBeenCalledTimes(1);
  });
});
