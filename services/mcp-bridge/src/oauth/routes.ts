/**
 * WARP-2401 — the bridge's `/oauth/*` routes. The orchestrator owns the flow
 * (state, cookie, pending verifier, token store); the bridge only makes the
 * outbound hops, because the bridge is the one process allowed to dial out
 * (ADR-043 section 5) and every hop goes through the pinned fetch.
 *
 * Bearer-checked by `http-api.ts` before this runs. The caller's log line is
 * method, path and status only: a body here carries a code, a verifier, a
 * refresh token or a client secret, and none of it is ever logged or echoed
 * (rule 19). A refusal names a FIELD or our own reason, never a value.
 */
import type { BridgeResponse } from "../http-api.js";
import { ATLASSIAN_ALLOWED_OAUTH_HOSTS } from "../atlassian.js";
import { UnsafeMcpUrlError } from "../safe-url.js";
import { isAllowedRedirectUri, registerClient } from "./dcr.js";
import { discover } from "./discovery.js";
import { OAuthRefusedError, OAuthTokenError, PkceUnsupportedError } from "./errors.js";
import { asRecord, hostSetOf, vetUrl, type OAuthDeps } from "./http.js";
import { isValidVerifier } from "./pkce.js";
import { exchangeCode, refreshToken, revokeToken } from "./token.js";

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): BridgeResponse {
  return { status, body: { error: { code, message }, ...extra } };
}

/** A required string with a length bound, or null. */
function str(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/**
 * Hosts a hop may reach. The curated Atlassian set wins whenever the URL is on
 * one of its hosts, whatever the caller says; any other server needs the caller
 * to name its hosts, and the empty set refuses everything.
 */
function allowedFor(rawUrl: string, callerList: unknown): ReadonlySet<string> {
  try {
    if (ATLASSIAN_ALLOWED_OAUTH_HOSTS.has(new URL(rawUrl).hostname.toLowerCase())) return ATLASSIAN_ALLOWED_OAUTH_HOSTS;
  } catch {
    /* fall through to the caller's list; vetUrl refuses a non-URL */
  }
  return hostSetOf(callerList);
}

function mapError(e: unknown): BridgeResponse {
  if (e instanceof PkceUnsupportedError) return fail(422, e.code, e.message);
  if (e instanceof OAuthRefusedError) return fail(422, e.code, e.message, { reason: e.reason });
  if (e instanceof UnsafeMcpUrlError) return fail(422, "OAUTH_REFUSED", e.message, { reason: "UNSAFE_URL" });
  if (e instanceof OAuthTokenError) {
    return fail(502, e.code, e.message, { ...(e.oauthError ? { oauthError: e.oauthError } : {}), httpStatus: e.httpStatus });
  }
  // Transport errors (TLS, timeout, reset): the text is the network's, not ours.
  return fail(502, "REMOTE_CALL_FAILED", "The OAuth request failed.");
}

export async function handleOAuthRoute(
  action: string | undefined,
  method: string,
  rawBody: unknown,
  deps: OAuthDeps = {},
): Promise<BridgeResponse> {
  if (action === undefined || !["discover", "register", "exchange", "refresh", "revoke"].includes(action)) {
    return fail(404, "NOT_FOUND", `No route for /oauth/${action ?? ""}.`);
  }
  if (method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", `${method} is not allowed on /oauth/${action}.`);
  const body = asRecord(rawBody);
  if (!body) return fail(400, "INVALID_REQUEST", "Body must be a JSON object.");
  const missing = (...names: string[]) => fail(400, "INVALID_REQUEST", `Missing or invalid: ${names.join(", ")}.`);

  try {
    if (action === "discover") {
      const mcpUrl = str(body, "mcpUrl", 2048);
      if (!mcpUrl) return missing("mcpUrl");
      return { status: 200, body: await discover(mcpUrl, allowedFor(mcpUrl, body.allowedIssuerHosts), deps) };
    }

    if (action === "register") {
      const endpoint = str(body, "registrationEndpoint", 2048);
      const uris = body.redirectUris;
      if (!endpoint) return missing("registrationEndpoint");
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(isAllowedRedirectUri)) {
        return missing("redirectUris");
      }
      const url = await vetUrl(endpoint, allowedFor(endpoint, body.allowedHosts), deps);
      return { status: 200, body: await registerClient(url, { redirectUris: uris as string[] }, deps) };
    }

    const clientId = str(body, "clientId", 512);
    const clientSecret = body.clientSecret === undefined ? undefined : str(body, "clientSecret", 4096);
    if (!clientId) return missing("clientId");
    if (clientSecret === null) return missing("clientSecret");
    const secret = clientSecret === undefined ? {} : { clientSecret };

    if (action === "revoke") {
      const endpoint = str(body, "revocationEndpoint", 2048);
      const token = str(body, "token", 16_384);
      const rawHint = body.tokenTypeHint;
      const hint = rawHint === "access_token" || rawHint === "refresh_token" ? rawHint : undefined;
      if (!endpoint || !token) return missing(...(!endpoint ? ["revocationEndpoint"] : []), ...(!token ? ["token"] : []));
      if (rawHint !== undefined && hint === undefined) return missing("tokenTypeHint");
      const url = await vetUrl(endpoint, allowedFor(endpoint, body.allowedHosts), deps);
      await revokeToken({ revocationEndpoint: url, clientId, token, ...(hint ? { tokenTypeHint: hint } : {}) }, deps);
      return { status: 200, body: { revoked: true } };
    }

    const tokenEndpoint = str(body, "tokenEndpoint", 2048);
    const resource = str(body, "resource", 2048);
    if (!tokenEndpoint || !resource) {
      return missing(...(!tokenEndpoint ? ["tokenEndpoint"] : []), ...(!resource ? ["resource"] : []));
    }
    const url = await vetUrl(tokenEndpoint, allowedFor(tokenEndpoint, body.allowedHosts), deps);

    if (action === "exchange") {
      const code = str(body, "code", 4096);
      const redirectUri = body.redirectUri;
      const verifier = body.codeVerifier;
      if (!code) return missing("code");
      // A bare code never reaches the token endpoint without its verifier and redirect URI.
      if (!isValidVerifier(verifier)) return missing("codeVerifier");
      if (!isAllowedRedirectUri(redirectUri)) return missing("redirectUri");
      return {
        status: 200,
        body: await exchangeCode(
          { tokenEndpoint: url, clientId, ...secret, code, codeVerifier: verifier, redirectUri, resource },
          deps,
        ),
      };
    }

    // action === "refresh"
    const refresh = str(body, "refreshToken", 16_384);
    const scope = body.scope === undefined ? undefined : str(body, "scope", 4096);
    if (!refresh) return missing("refreshToken");
    if (scope === null) return missing("scope");
    return {
      status: 200,
      body: await refreshToken(
        { tokenEndpoint: url, clientId, ...secret, refreshToken: refresh, resource, ...(scope ? { scope } : {}) },
        deps,
      ),
    };
  } catch (e) {
    return mapError(e);
  }
}
