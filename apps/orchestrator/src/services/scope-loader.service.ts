/**
 * WARP-455 — scope-loader singleton.
 *
 * Fulfils the promise in `middleware/scope.ts` (module comment line 27):
 * "Production wiring lives in `services/scope-loader.service.ts`
 * (singleton bound to the orchestrator's PrismaClient)."
 *
 * `requireScope(resource, loadUserScopes)` delegates scope lookup to an
 * injected loader so the middleware compiles standalone and unit tests
 * can pass a fixed Set without a DB. This module is that production
 * loader: a Prisma-bound singleton mirroring `activity.singleton.ts`
 * (module-scoped prisma var, idempotent boot init, `_setForTests` reset
 * hook) so route mounts don't have to thread Prisma through every
 * callsite.
 *
 * `loadUserEffectiveScopes(userId)` returns the set of scopes a user
 * holds, applying the guest time-box FIRST: a guest whose GuestExpiry
 * row has been swept to `EXPIRED` holds NO effective scopes regardless
 * of any stored ScopeBinding rows. Per the no-guessing / explicit-state
 * rule (CLAUDE.md) and the schema comment at schema.prisma:1098-1103,
 * the time-box is keyed on the explicit `GuestExpiryStatus` enum
 * (ACTIVE|EXPIRED) — NEVER derived from `expiresAt < now()` at read
 * time (the WARP-218 BrainMemoryItemStatus precedent).
 *
 * Fail-closed posture: if the singleton is unwired, the loader THROWS
 * rather than returning an empty Set. The middleware's try/catch turns
 * a throw into a 500 (operational error → dashboard toast + retry),
 * which is correct — silently returning an empty Set would 403 a
 * legitimate user, mirroring the auth.ts OCS-unreachable → 500 path.
 *
 * No crypto. No while-loop.
 */
import type { PrismaClient } from "@prisma/client";
import type { ScopeName } from "../middleware/scope.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("scope-loader");

let scopeLoaderPrisma: PrismaClient | null = null;

/**
 * Bind the orchestrator's PrismaClient at boot. Idempotent — a second
 * call is a no-op so a test that wires the loader once doesn't have to
 * teardown between cases (same contract as `initActivityRecorder`).
 */
export function initScopeLoader(prisma: PrismaClient): void {
  if (scopeLoaderPrisma) return;
  scopeLoaderPrisma = prisma;
}

/**
 * Load the set of scopes the user effectively holds.
 *
 * (a) Throws if the singleton is unwired — fail-closed → 500 in the
 *     middleware, NOT a silent empty-Set that would 403 a real user.
 * (b) Checks the guest time-box first: a swept-EXPIRED guest holds no
 *     effective scopes (explicit `status` enum check, never derived
 *     from `expiresAt`).
 * (c) Otherwise returns the user's ScopeBinding scopes as a Set.
 */
export async function loadUserEffectiveScopes(
  userId: string,
): Promise<Set<ScopeName>> {
  const prisma = scopeLoaderPrisma;
  if (!prisma) {
    throw new Error("scope-loader not initialised");
  }

  // Guest time-box first. A guest whose session has been swept to
  // EXPIRED holds NO effective scopes regardless of stored bindings.
  // Explicit-enum check (status === "EXPIRED") per schema.prisma:1098.
  const expiry = await prisma.guestExpiry.findUnique({ where: { userId } });
  if (expiry && expiry.status === "EXPIRED") {
    logger.debug({ userId }, "guest time-box EXPIRED — no effective scopes");
    return new Set<ScopeName>();
  }

  const rows = await prisma.scopeBinding.findMany({
    where: { userId },
    select: { scope: true },
  });
  return new Set<ScopeName>(rows.map((r) => r.scope as ScopeName));
}

/** Exposed only for tests — inject a fake prisma or reset to null. */
export function _setScopeLoaderPrismaForTests(
  prisma: PrismaClient | null,
): void {
  scopeLoaderPrisma = prisma;
}
