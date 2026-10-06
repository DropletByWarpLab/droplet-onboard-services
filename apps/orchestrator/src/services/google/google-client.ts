/** Gmail's browser consent and token endpoints are fixed: no user-provided URLs. */
import { canonicalGoogleScopes, DEFAULT_GOOGLE_FEATURES, googleGrantCovers, scopesForGoogleFeatures } from "./scopes.js";
export { GOOGLE_MAIL_SCOPE } from "./scopes.js";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 15_000;

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  grantedScopes: string[];
}

export interface GoogleProvider {
  getAuthorizationUrl(app: GoogleApp, opts: {
    redirectUri: string; state: string; codeChallenge: string; scopes?: readonly string[];
  }): string;
  exchangeCode(app: GoogleApp, opts: {
    code: string; redirectUri: string; codeVerifier: string; scopes?: readonly string[];
  }): Promise<GoogleTokens>;
  refresh(app: GoogleApp, refreshToken: string, scopes?: readonly string[]): Promise<GoogleTokens>;
  getAccountAddress(accessToken: string): Promise<string>;
  revoke(refreshToken: string): Promise<void>;
}

/** Only the classification crosses this boundary; provider bodies never do. */
export class GoogleProviderError extends Error {
  constructor(public readonly needsReconnect = false) {
    super(needsReconnect ? "Google sign-in needs to be renewed." : "Google is temporarily unavailable.");
    this.name = "GoogleProviderError";
  }
}

export function createGoogleProvider(fetcher: typeof fetch = fetch): GoogleProvider {
  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GoogleProviderError();
    }
  }

  async function tokens(app: GoogleApp, grant: Record<string, string>, requested: readonly string[], refresh = false): Promise<GoogleTokens> {
    const response = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...grant, client_id: app.clientId, client_secret: app.clientSecret }),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new GoogleProviderError(response.status === 400 && body?.error === "invalid_grant");
    }
    if (!body || typeof body.access_token !== "string" || !body.access_token ||
        typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
      throw new GoogleProviderError(true);
    }
    // Refresh responses may omit scope when unchanged (RFC 6749 §5.1/6).
    // The initial consent must explicitly report every requested permission.
    const scopes = typeof body.scope === "string" ? canonicalGoogleScopes(body.scope.split(" ").filter(Boolean))
      : refresh && body.scope === undefined ? [...requested] : [];
    if (!googleGrantCovers(scopes, requested)) throw new GoogleProviderError(true);
    return {
      accessToken: body.access_token,
      grantedScopes: scopes,
      ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    };
  }

  return {
    getAuthorizationUrl(app, opts) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: opts.redirectUri,
        response_type: "code",
        scope: (opts.scopes ?? scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES)).join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        code_challenge_method: "S256",
        code_challenge: opts.codeChallenge,
        state: opts.state,
      }).toString();
      return url.toString();
    },
    exchangeCode: (app, opts) => tokens(app, {
      grant_type: "authorization_code", code: opts.code,
      redirect_uri: opts.redirectUri, code_verifier: opts.codeVerifier,
    }, opts.scopes ?? scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES)),
    refresh: (app, refreshToken, scopes = scopesForGoogleFeatures(DEFAULT_GOOGLE_FEATURES)) =>
      tokens(app, { grant_type: "refresh_token", refresh_token: refreshToken }, scopes, true),
    async getAccountAddress(accessToken) {
      const response = await request(PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new GoogleProviderError(response.status === 401 || response.status === 403);
      const body = await response.json().catch(() => null) as { email?: unknown; verified_email?: unknown } | null;
      const address = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      if (body?.verified_email !== true || address.length > 254 || /[\x00-\x1f\x7f]/.test(address) ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new GoogleProviderError(true);
      return address;
    },
    async revoke(refreshToken) {
      const response = await request(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
      });
      // Already revoked is equivalent to successfully revoked.
      if (!response.ok && response.status !== 400) throw new GoogleProviderError();
    },
  };
}
