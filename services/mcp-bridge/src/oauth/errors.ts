/**
 * WARP-2401 — the typed refusals of the OAuth client. Every message here is
 * ours: none relays text from the counterparty (an authorization server's
 * `error_description` can echo a request, which carries a code or a token),
 * and none carries a code, state, token, verifier or redirect URL (rule 19).
 */

/** The authorization server does not advertise PKCE S256. RFC 7636 / the MCP
 *  authorization spec make S256 mandatory, so this is a REFUSAL, never a
 *  warning-and-continue. */
export class PkceUnsupportedError extends Error {
  readonly code = "OAUTH_PKCE_UNSUPPORTED";
  constructor() {
    super("the authorization server does not advertise PKCE S256 (code_challenge_methods_supported); refusing to sign in");
    this.name = "PkceUnsupportedError";
  }
}

/** A policy refusal: a host outside the curated set, an issuer or resource
 *  that does not match, a malformed document, an oversized body. */
export class OAuthRefusedError extends Error {
  readonly code = "OAUTH_REFUSED";
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthRefusedError";
  }
}

/** The token, registration or revocation endpoint answered non-2xx. Carries
 *  only the RFC 6749 `error` code (charset-checked), e.g. `invalid_grant`,
 *  which the orchestrator needs to tell "sign in again" from "retry". */
export class OAuthTokenError extends Error {
  readonly code = "OAUTH_TOKEN_ERROR";
  constructor(
    readonly httpStatus: number,
    readonly oauthError?: string,
  ) {
    super(`the OAuth endpoint refused the request (HTTP ${httpStatus}${oauthError ? `, ${oauthError}` : ""})`);
    this.name = "OAuthTokenError";
  }
}
