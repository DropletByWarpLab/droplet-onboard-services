import jwt from "jsonwebtoken";
import type { Role } from "@droplet/tools-core";

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
 *   - throws when the `role` claim is set to a non-canonical string (e.g.
 *     `"Admin"`, `"viewer"`, `""`). Defense in depth: a typo in the
 *     orchestrator's token issuer or a future service-account endpoint
 *     emitting an unrecognized role must NOT silently downgrade to
 *     `undefined`, because `undefined` is the stdio-trusted-principal
 *     sentinel in `rbac.ts`. The HTTP path catches this throw and
 *     returns 401 to the client.
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
  const sub = typeof decoded.sub === "string" ? decoded.sub : undefined;
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
