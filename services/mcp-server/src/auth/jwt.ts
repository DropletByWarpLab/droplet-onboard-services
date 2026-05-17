import jwt from "jsonwebtoken";
import type { Role } from "@droplet/tools-core";

/**
 * Mint a short-lived service JWT the mcp-server presents to the
 * orchestrator's REST API when a tool handler needs to fetch data via
 * HTTP (matter.controller.ts:listDevices et al). Claims match the shape
 * `apps/orchestrator/src/services/jwt.service.ts:signAccessToken` emits
 * — same JWT_SECRET (HS256) signs both, so the orchestrator's auth
 * middleware accepts this exactly like a user access token.
 *
 * sub:          stable identity for the service principal
 * username:     mirrors sub — orchestrator's AuthUser.id+username
 * displayName:  what shows up in audit logs as the actor
 * role:         "owner" — handlers need broad read access; voice's
 *               actual capability ceiling is enforced upstream at the
 *               /api/llm/chat layer (caller is role=service there, so
 *               write tools are filtered out of the LLM's tool list
 *               before any dispatch happens). The mcp-server-to-
 *               orchestrator hop is service-to-service infrastructure
 *               auth, not user RBAC — the orchestrator's RBAC for the
 *               outer chat call already settled what the LLM can ask
 *               for.
 * type:         "access" — verifyAccessToken rejects any other value.
 *
 * 60-second expiry: tokens are minted per request so a fresh one always
 * has plenty of clock skew margin; we don't store them.
 */
export function mintInternalToken(secret: string): string {
  return jwt.sign(
    {
      sub: "service:mcp-server",
      username: "service:mcp-server",
      displayName: "MCP Server",
      role: "owner" as Role,
      type: "access",
    },
    secret,
    { expiresIn: 60 },
  );
}

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
