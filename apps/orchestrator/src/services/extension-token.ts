/**
 * WARP-2900 (ADR-056 slice H3): the extension call-back bearer's shape, in a
 * module with no dependencies of its own.
 *
 * `middleware/auth.ts` resolves a `dxt_` bearer to the `_service:ext:<slug>`
 * principal, and every request on the box passes through it. Importing the
 * lifecycle service there would pull the sandbox client, the verifier and
 * the tool catalog into the auth middleware's module graph; these four names
 * are all it needs. `extension-lifecycle.service.ts` re-exports them, so its
 * H2 surface is unchanged.
 */
import { createHash } from "node:crypto";

/** Every extension bearer starts with this; no other credential does. */
export const EXTENSION_TOKEN_PREFIX = "dxt_";

/** The principal id prefix an extension bearer resolves to. */
export const EXTENSION_PRINCIPAL_PREFIX = "_service:ext:";

/** sha256 hex of the bearer: the only form the database ever holds. */
export function hashExtensionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extensionPrincipalId(slug: string): string {
  return `${EXTENSION_PRINCIPAL_PREFIX}${slug}`;
}
