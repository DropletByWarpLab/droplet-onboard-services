/**
 * WARP-2401 — RFC 6749 token exchange, refresh and RFC 7009 revocation.
 *
 * `resource` (RFC 8707) goes on BOTH the exchange and the refresh. Nothing is
 * kept from a response beyond the five fields {@link parseTokens} names; the
 * rest of the body (including `error_description`) is dropped on the floor.
 */
import { OAuthRefusedError, OAuthTokenError } from "./errors.js";
import { asRecord, fetchBounded, type OAuthDeps } from "./http.js";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

/** The RFC 6749 `error` code, only if it is a short token. */
export function oauthErrorOf(json: unknown): string | undefined {
  const e = asRecord(json)?.error;
  return typeof e === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e) ? e : undefined;
}

async function postForm(deps: OAuthDeps, url: string, form: URLSearchParams): Promise<unknown> {
  const { status, json } = await fetchBounded(deps, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  if (status < 200 || status >= 300) throw new OAuthTokenError(status, oauthErrorOf(json));
  return json;
}

const MAX_TOKEN_CHARS = 16_384;
const MAX_EXPIRES_IN = 365 * 24 * 3600;

function parseTokens(json: unknown): TokenSet {
  const doc = asRecord(json);
  const bad = (why: string) => new OAuthRefusedError("BAD_TOKEN_RESPONSE", `the token response ${why}`);
  if (!doc) throw bad("is not a JSON object");
  const { access_token, token_type, refresh_token, expires_in, scope } = doc;
  if (typeof access_token !== "string" || access_token.length === 0 || access_token.length > MAX_TOKEN_CHARS) {
    throw bad("has no access_token");
  }
  // The token goes out as `Authorization: Bearer`; any other type is not one we can present.
  if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") throw bad("is not a bearer token");
  if (refresh_token !== undefined && (typeof refresh_token !== "string" || refresh_token.length > MAX_TOKEN_CHARS)) {
    throw bad("has a malformed refresh_token");
  }
  if (
    expires_in !== undefined &&
    (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0 || expires_in > MAX_EXPIRES_IN)
  ) {
    throw bad("has a malformed expires_in");
  }
  if (scope !== undefined && (typeof scope !== "string" || scope.length > 4096)) throw bad("has a malformed scope");
  return {
    accessToken: access_token,
    ...(refresh_token ? { refreshToken: refresh_token as string } : {}),
    ...(expires_in !== undefined ? { expiresIn: expires_in as number } : {}),
    ...(scope !== undefined ? { scope: scope as string } : {}),
  };
}

export async function exchangeCode(
  p: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  // No `scope`: an authorization-code exchange cannot ask for more than was consented to.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.codeVerifier,
    resource: p.resource,
  });
  if (p.clientSecret) form.set("client_secret", p.clientSecret);
  return parseTokens(await postForm(deps, p.tokenEndpoint, form));
}

export async function refreshToken(
  p: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    resource: string;
    scope?: string;
  },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    client_id: p.clientId,
    resource: p.resource,
  });
  // Sent only when the caller names a scope, and then only the one it names.
  if (p.scope) form.set("scope", p.scope);
  if (p.clientSecret) form.set("client_secret", p.clientSecret);
  return parseTokens(await postForm(deps, p.tokenEndpoint, form));
}

export async function revokeToken(
  p: { revocationEndpoint: string; clientId: string; token: string; tokenTypeHint?: "access_token" | "refresh_token" },
  deps: OAuthDeps = {},
): Promise<void> {
  const form = new URLSearchParams({ token: p.token, client_id: p.clientId });
  if (p.tokenTypeHint) form.set("token_type_hint", p.tokenTypeHint);
  await postForm(deps, p.revocationEndpoint, form);
}
