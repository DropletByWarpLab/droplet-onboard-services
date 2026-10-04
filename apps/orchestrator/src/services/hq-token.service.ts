/**
 * WARP-3503 — the box's ONE client for short-lived HQ device tokens (fleet
 * contract v1 §2, ADR-068). Every box-to-HQ credential comes from here: the
 * OTA image pull asks for `registry:pull`, the telemetry sender (WARP-3504)
 * asks for `telemetry:ingest` through the same instance.
 *
 *   POST /v1/device/challenge  {key_fingerprint}            → {nonce}
 *   sign `droplet-hq-token:v1:<nonce>:<key_fingerprint>` with the device key
 *   POST /v1/device/token      {key_fingerprint, nonce, sig_alg, signature,
 *                               scopes}                      → {token, expires_in}
 *
 * `key_fingerprint` is the SHA-256 of the DER SubjectPublicKeyInfo of the
 * device key, lowercase hex, no prefix. It is NOT the `certFingerprint` the
 * TLS-issuance and overlay flows send (`sha256:` + hash of the cert PEM);
 * those paths are unchanged and HQ resolves this one by SPKI.
 *
 * The HQ base URL is `HQ_ISSUANCE_URL` (the same origin as TLS issuance) and
 * signing goes through the device-identity sidecar, both injected.
 *
 * SECURITY: a token is a bearer credential. Nothing here logs one, and no
 * error message ever carries one; callers must keep it out of argv and logs.
 */
import { createHash, X509Certificate } from "node:crypto";
import type { DeviceIdentityClient } from "./device-identity.client.js";

/** The exact prefix HQ verifies (domain-separated from cert/provision/claim/release). */
export const HQ_TOKEN_SIGNED_PREFIX = "droplet-hq-token:v1:";

export type HqTokenScope = "registry:pull" | "telemetry:ingest";

/**
 * Why no token was issued. `unreachable` means "no definitive answer, try
 * again later": network, timeout, 5xx, 429, a 400/bad_nonce, a malformed
 * reply, or the local device-identity sidecar failing. The other three are
 * HQ's explicit refusals.
 */
export type HqTokenFailure = "not_enrolled" | "revoked" | "unreachable" | "bad_signature";

export class HqTokenError extends Error {
  readonly reason: HqTokenFailure;
  /** Where it failed (endpoint, HTTP status, HQ error code). Never a token. */
  readonly detail: string;
  constructor(reason: HqTokenFailure, detail: string) {
    super(`HQ token ${reason}: ${detail}`);
    this.name = "HqTokenError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface HqToken {
  /** The bearer JWT. Secret: never log it. */
  token: string;
  /** Epoch ms, from the reply's `expires_in` (not from the JWT, so clock skew can't shorten it). */
  expiresAt: number;
}

export interface HqTokenService {
  /** The HQ origin's `host[:port]`, lowercase: the registry host that takes these tokens. */
  readonly host: string;
  /**
   * A token covering `scopes`, cached until `minRemainingMs` (default 60 s)
   * before it expires. Pass a larger `minRemainingMs` when the caller needs
   * the token to outlive a long operation. Throws HqTokenError.
   */
  getToken(scopes: readonly HqTokenScope[], opts?: { minRemainingMs?: number }): Promise<HqToken>;
}

export interface HqTokenServiceDeps {
  /** `HQ_ISSUANCE_URL`. */
  baseUrl: string;
  identity: Pick<DeviceIdentityClient, "getDeviceCert" | "signWithDeviceKey">;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createHqTokenService(deps: HqTokenServiceDeps): HqTokenService {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map<string, HqToken>();

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HqTokenError("unreachable", err instanceof Error ? err.message : String(err));
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) {
      if (json === null || typeof json !== "object") {
        throw new HqTokenError("unreachable", `${path} answered ${res.status} with a malformed body`);
      }
      return json;
    }
    const code = typeof json?.error === "string" ? json.error : "";
    if (res.status === 403 && code === "not_enrolled") throw new HqTokenError("not_enrolled", path);
    if (res.status === 403 && code === "revoked") throw new HqTokenError("revoked", path);
    if (res.status === 401 && code === "bad_signature") throw new HqTokenError("bad_signature", path);
    throw new HqTokenError("unreachable", `${path} answered ${res.status}${code ? ` ${code}` : ""}`);
  }

  async function mint(scopes: HqTokenScope[]): Promise<HqToken> {
    // Measured before the requests, so a slow round trip can only shorten the
    // token's life as we see it, never lengthen it.
    const startedAt = now();
    let fingerprint: string;
    try {
      const spki = new X509Certificate(await deps.identity.getDeviceCert()).publicKey.export({
        type: "spki",
        format: "der",
      });
      fingerprint = createHash("sha256").update(spki).digest("hex");
    } catch (err) {
      throw new HqTokenError("unreachable", `device identity: ${err instanceof Error ? err.message : String(err)}`);
    }
    const challenge = await post("/v1/device/challenge", { key_fingerprint: fingerprint });
    const nonce = challenge.nonce;
    if (typeof nonce !== "string" || nonce === "") {
      throw new HqTokenError("unreachable", "challenge reply has no nonce");
    }
    let signature: string;
    try {
      const signed = await deps.identity.signWithDeviceKey(
        new TextEncoder().encode(`${HQ_TOKEN_SIGNED_PREFIX}${nonce}:${fingerprint}`),
      );
      signature = Buffer.from(signed.signature).toString("base64");
    } catch (err) {
      throw new HqTokenError("unreachable", `device identity: ${err instanceof Error ? err.message : String(err)}`);
    }
    const issued = await post("/v1/device/token", {
      key_fingerprint: fingerprint,
      nonce,
      sig_alg: "ecdsa-p256-sha256",
      signature,
      scopes,
    });
    const { token, expires_in: expiresIn } = issued;
    if (typeof token !== "string" || token === "" || typeof expiresIn !== "number" || !(expiresIn > 0)) {
      throw new HqTokenError("unreachable", "token reply is malformed");
    }
    return { token, expiresAt: startedAt + expiresIn * 1000 };
  }

  // A malformed URL yields "" (matches no image ref) rather than failing boot.
  let host = "";
  try {
    host = new URL(base).host.toLowerCase();
  } catch {
    // keep ""
  }

  return {
    host,
    async getToken(scopes, opts) {
      const wanted = [...new Set(scopes)].sort();
      const key = wanted.join(" ");
      const margin = Math.max(opts?.minRemainingMs ?? 0, DEFAULT_REFRESH_MARGIN_MS);
      const hit = cache.get(key);
      if (hit && hit.expiresAt - now() > margin) return hit;
      const fresh = await mint(wanted);
      cache.set(key, fresh);
      return fresh;
    },
  };
}

let shared: HqTokenService | null = null;

/** Boot wiring (index.ts): the one instance every box-to-HQ caller shares. */
export function initHqTokenService(deps: HqTokenServiceDeps): HqTokenService {
  shared = createHqTokenService(deps);
  return shared;
}

/** The shared instance, or null when HQ is not configured on this box. */
export function getHqTokenService(): HqTokenService | null {
  return shared;
}
