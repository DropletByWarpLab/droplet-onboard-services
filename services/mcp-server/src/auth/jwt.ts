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
 *   - normalizes a missing or unknown `role` claim to `undefined` so RBAC
 *     treats the caller as an unprivileged unrole-bearing principal
 *   - never throws because of an unexpected `role` value (it just becomes
 *     undefined) so we don't accidentally upgrade a parse error into a
 *     500 in callers
 */
export function verifyJwt(token: string, secret: string): Claims {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded === "string") {
    throw new Error("malformed token: payload is a string, expected object");
  }
  const sub = typeof decoded.sub === "string" ? decoded.sub : undefined;
  const roleClaim = (decoded as { role?: unknown }).role;
  const role =
    typeof roleClaim === "string" && VALID_ROLES.has(roleClaim as Role)
      ? (roleClaim as Role)
      : undefined;
  return { sub, role };
}
