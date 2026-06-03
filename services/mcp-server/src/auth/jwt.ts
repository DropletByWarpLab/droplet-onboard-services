import jwt from "jsonwebtoken";
import type { Role } from "@droplet/tools-core";

// NOTE (TOOLS-05): a `mintInternalToken` helper that minted a
// `role: "owner"` service JWT used to live here. It had zero call sites —
// the real mcp→orchestrator client uses the static `ORCHESTRATOR_TOKEN`
// env, which `matchServiceToken` maps to `role: "service"`. The dead
// helper was a latent IDOR footgun: wiring it onto the HTTP client would
// have silently upgraded every service-to-service hop from `service` to
// `owner`, bypassing the orchestrator's `isPrivileged`/ownership checks
// (matter/email/etc.). Removed. If a deliberate service token is ever
// needed, mint `role: "service"` to match the existing principal — never
// `owner`.

/**
 * Subset of JWT claims the MCP server cares about. All other claims
 * (`iat`, `exp`, custom orchestrator fields) are ignored — RBAC and
 * tool-context binding only need `sub` and `role`.
 *
 * Re-exported via the `Claims` symbol on `src/context.ts` to keep the
 * single source of truth here while letting callers that already pull
 * from `context.ts` keep working.
 */
export interface Claims {
  sub?: string;
  role?: Role;
}

const VALID_ROLES: ReadonlySet<Role> = new Set([
  "owner",
  "admin",
  "family",
  "guest",
]);

/**
 * Verifies a Bearer JWT against the shared HS256 secret and extracts
 * the orchestrator role + subject.
 *
 * Behavior contract:
 *   - throws on invalid signature, expired token, or any non-object payload
 *   - throws when the `type` claim is anything other than `"access"`.
 *     The orchestrator (`apps/orchestrator/src/services/jwt.service.ts`)
 *     issues two token types signed with the same `JWT_SECRET`: `access`
 *     (15 min) and `refresh` (7 day). The orchestrator's
 *     `verifyAccessToken` enforces `type === "access"`; the mcp-server
 *     mirrors that contract so a refresh token can't be presented as a
 *     Bearer to the MCP HTTP transport for its full lifetime. WARP-103
 *     reviewer follow-up.
 *   - throws when the `role` claim is set to a non-canonical string (e.g.
 *     `"Admin"`, `"viewer"`, `""`). Defense in depth: a typo in the
 *     orchestrator's token issuer or a future service-account endpoint
 *     emitting an unrecognized role must NOT silently downgrade to
 *     `undefined`, because `undefined` is the stdio-trusted-principal
 *     sentinel in `rbac.ts`. The HTTP path catches this throw and
 *     returns 401 to the client.
 *   - throws when `sub` is missing or empty. Matches the orchestrator's
 *     auth-middleware contract; an empty `sub` would otherwise bind a
 *     ToolContext with `userId: undefined` which is the stdio-only
 *     shape. WARP-103 reviewer follow-up.
 *   - normalizes a MISSING `role` claim (no `role` key in the payload at
 *     all, or explicitly `null`) to `undefined`. The HTTP path treats
 *     undefined-role-from-HTTP as untrusted+least-privilege via the
 *     `trustedPrincipal` parameter on the RBAC helpers — so undefined
 *     here no longer means "trusted" on the HTTP path.
 */
export function verifyJwt(token: string, secret: string): Claims {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded === "string") {
    throw new Error("malformed token: payload is a string, expected object");
  }

  // Token-type guard: reject anything other than the orchestrator's
  // access tokens. Refresh tokens (and any future per-purpose token
  // class signed with the same secret) must NOT verify here.
  const tokenType = (decoded as { type?: unknown }).type;
  if (typeof tokenType !== "string" || tokenType !== "access") {
    throw new Error(
      `expected token type "access", got ${typeof tokenType === "string" ? JSON.stringify(tokenType) : typeof tokenType}`,
    );
  }

  // Subject guard: empty / missing `sub` would otherwise leak through
  // as `userId: undefined` and bind a ToolContext that handlers can't
  // attribute. Matches the orchestrator's auth-middleware contract.
  const subClaim = (decoded as { sub?: unknown }).sub;
  if (typeof subClaim !== "string" || subClaim.length === 0) {
    throw new Error("missing or empty sub claim");
  }
  const sub = subClaim;

  const roleClaim = (decoded as { role?: unknown }).role;
  let role: Role | undefined;
  if (roleClaim === undefined || roleClaim === null) {
    role = undefined;
  } else if (typeof roleClaim === "string" && VALID_ROLES.has(roleClaim as Role)) {
    role = roleClaim as Role;
  } else {
    // Unknown / non-canonical role string. Reject hard.
    throw new Error(
      `unrecognized role claim: ${typeof roleClaim === "string" ? JSON.stringify(roleClaim) : typeof roleClaim}`,
    );
  }
  return { sub, role };
}
