/**
 * WARP-2900 (ADR-056 slice H3): the database lookup behind an extension's
 * `dxt_` call-back bearer.
 *
 * `middleware/auth.ts` used to hold a process-wide Prisma for its Nextcloud
 * fallback (`setAuthPrisma`). Stage retired that fallback and the binding
 * with it (WARP-2994, #2309). The extension bearer is the one auth path left
 * that reads the database, so it keeps its own binding here: typed to the
 * Extension table only, bound once by `createApp`, and failing closed while
 * unbound (a request before boot resolves no extension).
 */
import type { PrismaClient } from "@prisma/client";
import type { AuthUser } from "../middleware/auth.js";
import { EXTENSION_BEARER_STATUSES, extensionPrincipalId, hashExtensionToken } from "./extension-token.js";

type ExtensionPrincipalPrisma = Pick<PrismaClient, "extension">;

let bound: ExtensionPrincipalPrisma | null = null;

/** Bind the client the bearer lookup reads. `null` unbinds (tests). */
export function bindExtensionPrincipalPrisma(prisma: ExtensionPrincipalPrisma | null): void {
  bound = prisma;
}

/**
 * The extension whose current bearer this is, as its call-back principal,
 * or null. Only a row whose process should be running counts. The lookup is
 * by the bearer's sha256 (a unique column); the plaintext never reaches the
 * database.
 */
export async function resolveExtensionPrincipal(token: string): Promise<AuthUser | null> {
  if (!bound) return null;
  const row = await bound.extension.findUnique({
    where: { serviceTokenHash: hashExtensionToken(token) },
    select: { id: true, status: true },
  });
  if (!row || !EXTENSION_BEARER_STATUSES.includes(row.status)) return null;
  const id = extensionPrincipalId(row.id);
  return { id, username: id, displayName: `Extension ${row.id}`, role: "service", extensionId: row.id };
}
