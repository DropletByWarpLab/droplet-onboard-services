/**
 * WARP-2401 — RFC 7591 dynamic client registration.
 *
 * DEPRECATED BY THE SPEC. MCP authorization revision 2026-07-28 deprecates
 * dynamic client registration in favour of client ID metadata documents
 * (CIMD). It stays here as a FALLBACK rung of the identity ladder (own app,
 * CIMD, DCR, pasted client, API token), because Atlassian still offers DCR
 * and no bring-your-own app for MCP. Do not promote it to the main path; CIMD
 * is deferred only because v1 hosts no document (ADR-072 section 10).
 */
import { OAuthRefusedError, OAuthTokenError } from "./errors.js";
import { asRecord, fetchBounded, type OAuthDeps } from "./http.js";
import { oauthErrorOf } from "./token.js";

/** The box callback path, over https, or http on a loopback name (RFC 8252, any
 *  port). No userinfo, no query, no fragment. */
export function isAllowedRedirectUri(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "" || u.hash !== "") return false;
  // Only the box's own callback: a registered redirect to any other path or
  // query would let a code land somewhere the box does not read it.
  if (u.pathname !== "/api/mcp/oauth/callback" || u.search !== "") return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export async function registerClient(
  registrationEndpoint: string,
  input: { redirectUris: string[]; clientName?: string },
  deps: OAuthDeps = {},
): Promise<{ clientId: string; clientSecret?: string }> {
  if (input.redirectUris.length === 0 || !input.redirectUris.every(isAllowedRedirectUri)) {
    throw new OAuthRefusedError("BAD_REDIRECT_URI", "registration needs https or loopback redirect URIs");
  }
  const { status, json } = await fetchBounded(deps, registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      redirect_uris: input.redirectUris,
      client_name: input.clientName ?? "Droplet",
      application_type: "web",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (status < 200 || status >= 300) throw new OAuthTokenError(status, oauthErrorOf(json));
  const doc = asRecord(json);
  const id = doc?.client_id;
  const secret = doc?.client_secret;
  if (typeof id !== "string" || id.length === 0 || id.length > 512) {
    throw new OAuthRefusedError("BAD_REGISTRATION", "the registration response has no client_id");
  }
  return {
    clientId: id,
    ...(typeof secret === "string" && secret.length > 0 && secret.length <= 4096 ? { clientSecret: secret } : {}),
  };
}
