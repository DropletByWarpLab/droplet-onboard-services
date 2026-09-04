/**
 * WARP-2398 — the code-side exact-host guard for a runtime-configured MCP
 * endpoint. ADR-043 §6, which makes it MANDATORY rather than belt-and-braces:
 *
 *   *"the static scan cannot see hostnames assembled at runtime"* — a green
 *   `egress-gate` proves only that no unregistered LITERAL appears in the
 *   tree. So the registry entry and this guard are two controls with
 *   different failure modes, and neither substitutes for the other.
 *
 * Shape copied deliberately from
 * `services/erp-connector/src/quickbooks/online-connector.ts:145-192`
 * (ADR-043 §6 names it as the thing to reuse rather than reinvent):
 * https-only, no userinfo, exact hostname match, port 443 only, and a
 * distinct error type so the refusal is legible.
 *
 * ONE DELIBERATE DIFFERENCE. QuickBooks derives its host set from two
 * published base-URL constants, so the hosts are repo literals the egress
 * gate can extract. An MCP endpoint is operator-configured, so this module
 * holds **no host literal at all** — the allowed set is passed in, and an
 * empty set (the default everywhere until a server is registered on its own
 * ticket) refuses everything. That is what lets the client core land without
 * registering an egress host: `mcp.atlassian.com` becomes a literal in
 * WARP-2316's own PR, alongside its `allowed-egress.yaml` entry, where a
 * security review can see both at once.
 */

/** Thrown when a configured endpoint is one this component will not dial. */
export class UnsafeMcpUrlError extends Error {
  readonly code = "UNSAFE_MCP_URL";
  constructor(reason: string) {
    super(`refusing to open an MCP session there: ${reason}`);
    this.name = "UnsafeMcpUrlError";
  }
}

/**
 * Validate an operator-supplied MCP endpoint against an exact-host set, or
 * throw {@link UnsafeMcpUrlError}.
 *
 * Returns the normalised URL (scheme + host + path, trailing slashes
 * stripped) so callers store and dial the same string they screened.
 *
 * @param allowedHosts exact, lowercase hostnames. **Empty denies everything**
 *   — the fail-closed default, and the shipping state until a server's own
 *   ticket registers its host in `docs/security/allowed-egress.yaml`.
 */
export function assertSafeMcpUrl(
  raw: string,
  allowedHosts: ReadonlySet<string>,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeMcpUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    // A bearer or Basic credential over http is the credential given away.
    throw new UnsafeMcpUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    // Some clients resolve `https://evil@real.host/` to a different authority
    // than a reader expects; and userinfo in a config value is a credential
    // in a place nothing redacts.
    throw new UnsafeMcpUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (allowedHosts.size === 0) {
    throw new UnsafeMcpUrlError(
      "no remote MCP host is registered on this box (the allowed-host set is empty)",
    );
  }
  if (!allowedHosts.has(host)) {
    throw new UnsafeMcpUrlError(`"${host}" is not a registered remote MCP host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port
  // left standing is one the egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeMcpUrlError(
      `port ${url.port} — registered MCP hosts are allowed on 443 only`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Parse an operator-supplied allowed-host list into the exact-match set
 * {@link assertSafeMcpUrl} takes. Unset / blank yields the empty set, which
 * denies every endpoint.
 */
export function parseAllowedMcpHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}
