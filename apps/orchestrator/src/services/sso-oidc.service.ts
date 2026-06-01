/**
 * ADR-013 (PR #378) — external-IdP OIDC sign-in (Google Workspace +
 * Microsoft Entra), orchestrator as the OIDC RELYING PARTY.
 *
 * This is the single boundary over the vetted `openid-client` (v6) library.
 * The route (`routes/sso.ts`) only touches these functions, so the route's
 * tests mock this module the same way the auth route mocks
 * `nextcloud.client.js`. openid-client owns the security-critical parts:
 *   - discovery() fetches /.well-known/openid-configuration + the JWKS;
 *   - authorizationCodeGrant() validates the ID token's SIGNATURE (via the
 *     discovered JWKS), `iss`, `aud`, `exp`, and — because we pass
 *     `expectedNonce` + `expectedState` + `pkceCodeVerifier` — the nonce,
 *     CSRF state, and PKCE binding too.
 *
 * Per-provider config (issuer / clientId / clientSecret / redirectUri) is
 * read from env via config.ts (DROPLET_SSO_*). NOTHING here hardcodes a
 * provider host — the issuer URL is the only source and openid-client
 * derives every endpoint from it. Secrets are read, never logged.
 */
import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  randomState,
  randomNonce,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
  type Configuration,
} from "openid-client";

import { config } from "../config.js";

/** The two IdPs this PR supports. Okta ships in a separate PR. */
export const SSO_PROVIDERS = ["google", "entra"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export interface OidcProviderConfig {
  provider: SsoProvider;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Type guard — only "google" / "entra" are valid providers. */
export function isSsoProvider(value: unknown): value is SsoProvider {
  return typeof value === "string" && (SSO_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolve a provider's config from env. Returns null when ANY of the four
 * required fields is blank — a half-configured provider is treated as
 * disabled so the route fails closed (no partial authorize URL, no SSO
 * button that 500s mid-flow).
 */
export function getOidcProviderConfig(provider: SsoProvider): OidcProviderConfig | null {
  const fields =
    provider === "google"
      ? {
          issuer: config.DROPLET_SSO_GOOGLE_ISSUER,
          clientId: config.DROPLET_SSO_GOOGLE_CLIENT_ID,
          clientSecret: config.DROPLET_SSO_GOOGLE_CLIENT_SECRET,
          redirectUri: config.DROPLET_SSO_GOOGLE_REDIRECT_URI,
        }
      : {
          issuer: config.DROPLET_SSO_ENTRA_ISSUER,
          clientId: config.DROPLET_SSO_ENTRA_CLIENT_ID,
          clientSecret: config.DROPLET_SSO_ENTRA_CLIENT_SECRET,
          redirectUri: config.DROPLET_SSO_ENTRA_REDIRECT_URI,
        };

  if (!fields.issuer || !fields.clientId || !fields.clientSecret || !fields.redirectUri) {
    return null;
  }
  return { provider, ...fields };
}

/** Which configured providers are live — used by the route's discovery check. */
export function enabledSsoProviders(): SsoProvider[] {
  return SSO_PROVIDERS.filter((p) => getOidcProviderConfig(p) !== null);
}

/** Scopes requested at the IdP. `openid` is required; email/profile give us
 *  the address (account-linking key) and the display name. */
const SSO_SCOPE = "openid email profile";

/** Build (and discover) an openid-client Configuration for a provider, or
 *  throw if the provider isn't configured. Internal — the route never sees
 *  a Configuration, only the wrapper functions below. */
async function discoverProvider(cfg: OidcProviderConfig): Promise<Configuration> {
  // discovery() fetches the provider's well-known document and JWKS. The
  // returned Configuration is what authorizationCodeGrant uses to validate
  // ID-token signatures. clientSecret is supplied so the confidential-client
  // token exchange (client_secret_basic by default) authenticates.
  return discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret);
}

export interface AuthorizeRequest {
  authorizeUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Mint the per-attempt secrets (state / nonce / PKCE verifier) and build the
 * provider authorize URL. The caller persists state/nonce/codeVerifier
 * server-side (SsoLoginState) and redirects the browser to `authorizeUrl`.
 */
export async function buildAuthorizeRequest(provider: SsoProvider): Promise<AuthorizeRequest> {
  const cfg = getOidcProviderConfig(provider);
  if (!cfg) {
    throw new Error(`SSO provider "${provider}" is not configured`);
  }

  const configuration = await discoverProvider(cfg);

  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

  const authorizeUrl = buildAuthorizationUrl(configuration, {
    redirect_uri: cfg.redirectUri,
    scope: SSO_SCOPE,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return { authorizeUrl: authorizeUrl.href, state, nonce, codeVerifier };
}

export interface ValidatedIdentity {
  /** IdP stable `sub` claim — the SsoIdentity link key. */
  sub: string;
  /** Email claim, RAW (the route normalizes via #374 trim+lowercase). May
   *  be undefined if the IdP didn't return one. */
  email?: string;
  /** Display name claim, if present. */
  name?: string;
}

export interface CallbackChecks {
  expectedNonce: string;
  codeVerifier: string;
  expectedState: string;
}

/**
 * Exchange the authorization code and VALIDATE the ID token. Delegates the
 * cryptographic checks to openid-client (signature via the discovered JWKS,
 * `iss`, `aud`, `exp`) and pins the `nonce`, `state`, and PKCE verifier so a
 * replayed or forged callback is rejected. Returns the validated identity.
 *
 * Throws on any validation failure — callers MUST NOT treat a thrown error
 * as a sign-in. We never log the code, tokens, or claims here.
 */
export async function exchangeCodeAndValidate(
  provider: SsoProvider,
  currentUrl: URL,
  checks: CallbackChecks,
): Promise<ValidatedIdentity> {
  const cfg = getOidcProviderConfig(provider);
  if (!cfg) {
    throw new Error(`SSO provider "${provider}" is not configured`);
  }

  const configuration = await discoverProvider(cfg);

  const tokens = await authorizationCodeGrant(configuration, currentUrl, {
    expectedNonce: checks.expectedNonce,
    expectedState: checks.expectedState,
    pkceCodeVerifier: checks.codeVerifier,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
  if (!sub) {
    // An ID token without a usable subject can't be linked to a local user.
    throw new Error("ID token has no usable subject (sub) claim");
  }
  const email = typeof claims?.email === "string" ? claims.email : undefined;
  const name = typeof claims?.name === "string" ? claims.name : undefined;

  return { sub, email, name };
}
