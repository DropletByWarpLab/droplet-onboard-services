/**
 * WARP-2398 — the credential a remote MCP session presents, and the rules
 * that keep it out of everything else.
 *
 * ATLASSIAN'S HEADLESS PATH is why Basic exists here at all. ADR-043 §7
 * classifies Atlassian as the **customer-created credential** model: the
 * customer's own admin mints an API token in their own tenant, and the box
 * presents `Authorization: Basic base64(email:api_token)` against
 * `https://mcp.atlassian.com/v1/mcp`. No browser, no redirect URI, no
 * authorization-code flow — which is what makes WARP-2316 buildable on an
 * appliance with no public inbound path (ADR-009). The OAuth subtasks under
 * WARP-2300 exist for Slack only, and Slack is blocked on WARP-2402.
 *
 * RULE 19 IS THE POINT OF THIS FILE. The credential is held in a closure,
 * never on an enumerable property, and the only thing that leaves is a
 * header object handed straight to the transport. There is no `toString`,
 * no getter, and no field a structured logger could walk into. The
 * `describe()` on {@link RemoteMcpCredential} exists so an operator surface
 * has something safe to render, which is the alternative to someone printing
 * the credential because there was nothing else to print.
 */

/** What a credential can be asked for without ever exposing itself. */
export interface RemoteMcpCredential {
  /** The auth scheme, for operator display. Never the material. */
  readonly scheme: "basic" | "bearer" | "none";
  /**
   * Headers to merge into the transport's `requestInit`. Freshly built on
   * every call so no caller can hold a reference and mutate it into a log.
   */
  headers(): Record<string, string>;
  /**
   * A short, safe description for logs and health payloads:
   * `basic(alice@example.test)` — the principal, never the secret. Basic
   * carries an identity half that is not secret and IS the thing an operator
   * needs to see to answer "which account is this connected as".
   */
  describe(): string;
}

/** No credential — an unauthenticated MCP endpoint (test doubles, and a
 *  local server on the LAN). */
export function noCredential(): RemoteMcpCredential {
  return {
    scheme: "none",
    headers: () => ({}),
    describe: () => "none",
  };
}

/**
 * `Authorization: Basic base64(email:apiToken)` — the Atlassian headless
 * path (WARP-2316).
 *
 * `email` is retained for {@link RemoteMcpCredential.describe}; `apiToken`
 * is captured by the closure and referenced nowhere else.
 */
export function basicCredential(email: string, apiToken: string): RemoteMcpCredential {
  if (email.length === 0 || apiToken.length === 0) {
    throw new Error("basic credential requires both an email and an API token");
  }
  const encoded = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
  return {
    scheme: "basic",
    headers: () => ({ Authorization: `Basic ${encoded}` }),
    describe: () => `basic(${email})`,
  };
}

/** `Authorization: Bearer <token>` — for a server that takes an opaque
 *  token rather than an email/token pair. */
export function bearerCredential(token: string): RemoteMcpCredential {
  if (token.length === 0) throw new Error("bearer credential requires a token");
  return {
    scheme: "bearer",
    headers: () => ({ Authorization: `Bearer ${token}` }),
    describe: () => "bearer",
  };
}
