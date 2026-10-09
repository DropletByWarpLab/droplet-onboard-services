/**
 * WARP-2401 — RFC 9728 protected-resource discovery and RFC 8414
 * authorization-server discovery, with the three refusals this flow stands on:
 *
 *   - `resource` must equal the MCP URL we asked about (RFC 9728 §3.3),
 *   - `issuer` must equal, string for string, the issuer we fetched it from,
 *   - `code_challenge_methods_supported` must contain `S256`
 *     ({@link PkceUnsupportedError}).
 *
 * Every URL, ours or taken from a document, is held to an exact-host set and
 * re-screened through `resolvePublicDestination` BEFORE it is used or returned.
 */
import { OAuthRefusedError, PkceUnsupportedError } from "./errors.js";
import { asRecord, fetchBounded, vetUrl, type OAuthDeps } from "./http.js";

export interface DiscoveredOAuth {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  tokenEndpointAuthMethods: string[];
  scopesSupported: string[];
  /** RFC 9207: when true the callback MUST carry `iss`. */
  authorizationResponseIssParameterSupported: boolean;
  /** Advertised only; v1 does not host a client-metadata document. */
  clientIdMetadataDocumentSupported: boolean;
}

async function firstJson(deps: OAuthDeps, urls: string[]): Promise<Record<string, unknown>> {
  for (const url of urls) {
    // A guard refusal (UnsafeMcpUrlError) propagates: only an HTTP miss or a
    // non-JSON body moves on to the next well-known form.
    const { status, json } = await fetchBounded(deps, url, { method: "GET", headers: { accept: "application/json" } });
    const doc = asRecord(json);
    if (status >= 200 && status < 300 && doc) return doc;
  }
  throw new OAuthRefusedError("DISCOVERY_FAILED", "no OAuth metadata document was found");
}

function stringList(v: unknown, max = 64): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && e.length <= 512).slice(0, max) : [];
}

/** RFC 9728: path-suffixed form first, root form second. */
export async function discoverProtectedResource(
  mcpUrl: string,
  allowedHosts: ReadonlySet<string>,
  deps: OAuthDeps = {},
): Promise<{ resource: string; authorizationServers: string[] }> {
  const mcp = await vetUrl(mcpUrl, allowedHosts, deps);
  const u = new URL(mcp);
  const suffix = u.pathname === "/" ? "" : u.pathname;
  const candidates = [`${u.origin}/.well-known/oauth-protected-resource${suffix}`];
  if (suffix !== "") candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);
  const doc = await firstJson(deps, candidates);
  // Exact, as RFC 9728 requires: a document that names another resource is
  // someone else's metadata and must not steer this server's sign-in.
  if (doc.resource !== mcpUrl) {
    throw new OAuthRefusedError("RESOURCE_MISMATCH", "the protected-resource metadata names a different resource");
  }
  // Only servers on the allowed set survive; none surviving is a refusal,
  // decided before any of them is dialed.
  const authorizationServers = stringList(doc.authorization_servers).filter((s) => {
    try {
      return allowedHosts.has(new URL(s).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  if (authorizationServers.length === 0) {
    throw new OAuthRefusedError("HOST_NOT_ALLOWED", "the resource names no authorization server on an allowed host");
  }
  return { resource: mcpUrl, authorizationServers };
}

/** RFC 8414: path-insertion form first, then `<issuer>/.well-known/oauth-authorization-server`. */
export async function discoverAuthorizationServer(
  issuerUrl: string,
  allowedHosts: ReadonlySet<string>,
  deps: OAuthDeps = {},
): Promise<Omit<DiscoveredOAuth, "resource">> {
  const issuer = await vetUrl(issuerUrl, allowedHosts, deps);
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}${path}/.well-known/oauth-authorization-server`,
  ];
  const doc = await firstJson(deps, [...new Set(candidates)]);
  if (doc.issuer !== issuerUrl) {
    throw new OAuthRefusedError("ISSUER_MISMATCH", "the metadata issuer does not equal the issuer it was fetched for");
  }
  if (!stringList(doc.code_challenge_methods_supported).includes("S256")) {
    throw new PkceUnsupportedError();
  }
  const endpoint = async (key: string, required: boolean): Promise<string | undefined> => {
    const v = doc[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || v.length === 0 || v.length > 2048) {
      throw new OAuthRefusedError("BAD_METADATA", `the metadata has no usable ${key}`);
    }
    return vetUrl(v, allowedHosts, deps);
  };
  const registrationEndpoint = await endpoint("registration_endpoint", false);
  const revocationEndpoint = await endpoint("revocation_endpoint", false);
  return {
    issuer: issuerUrl,
    authorizationEndpoint: (await endpoint("authorization_endpoint", true))!,
    tokenEndpoint: (await endpoint("token_endpoint", true))!,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    tokenEndpointAuthMethods: stringList(doc.token_endpoint_auth_methods_supported),
    scopesSupported: stringList(doc.scopes_supported, 256),
    authorizationResponseIssParameterSupported: doc.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocumentSupported: doc.client_id_metadata_document_supported === true,
  };
}

/** The whole discovery: resource metadata, then the first authorization server that answers. */
export async function discover(
  mcpUrl: string,
  allowedHosts: ReadonlySet<string>,
  deps: OAuthDeps = {},
): Promise<DiscoveredOAuth> {
  const prm = await discoverProtectedResource(mcpUrl, allowedHosts, deps);
  // One server: v1 does not choose between several. The first allowed entry wins.
  const as = await discoverAuthorizationServer(prm.authorizationServers[0]!, allowedHosts, deps);
  return { resource: prm.resource, ...as };
}
