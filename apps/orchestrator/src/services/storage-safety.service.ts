/**
 * BUG-3 / ADR-019 — Storage safety-tier service.
 *
 * Gates the data-destroying pool operations and Tier-2 recordings allocation
 * changes. Storage writes are blocked for the AI and require confirmation;
 * pool operations are Tier 3 and owner-only, while recordings allocation is
 * Tier 2 and owner/admin. The token is executable only
 * via a single-use, short-TTL confirmation token BOUND TO {service, resourceId}.
 * A token minted to destroy `md0` cannot confirm a destroy of `md1`, nor a
 * format of `md0` — both the operation and the resource must match.
 *
 * WARP-3513: the one-time recovery-key reveal rides the same machinery as a
 * Tier-2 operation. The tier in every response and CommandAuditLog row is the
 * classification's (it used to be a hard-coded 3), and a confirmation can be
 * restricted to the services an endpoint is able to execute, so a token minted
 * for the reveal can never be spent at the generic confirm route.
 *
 * Mirrors network-safety.service.ts (same in-memory pending map, same
 * CommandAuditLog dual-write shape, same WARP-41 operation-mismatch defense),
 * specialised for the {service, resourceId} binding.
 */

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  classifyStorageCommand,
  endpointMismatchReason,
  STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS,
  STORAGE_MAX_PENDING_CONFIRMATIONS,
} from "../config/storage-safety-rules.js";
import type { SafetyTier } from "../config/safety-rules.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("storage-safety");

const DOMAIN = "storage";

interface PendingConfirmation {
  token: string;
  service: string;
  resourceId: string;
  params?: Record<string, unknown>;
  userId?: string;
  tier: SafetyTier;
  expiresAt: number;
}

/** In-memory pending confirmations: token -> PendingConfirmation. */
const pendingConfirmations = new Map<string, PendingConfirmation>();

export type EvaluateStorageResult =
  | { allowed: false; blocked: true; reason: string; tier: SafetyTier }
  | {
      allowed: false;
      requiresConfirmation: true;
      confirmationToken: string;
      reason: string;
      tier: SafetyTier;
    };

/**
 * Evaluate a storage command.
 *
 * - `source: "ai"` → BLOCKED. The AI can never mutate storage. (Belt to the
 *   braces of D5: these operations aren't in tools-core at all, so the AI
 *   can't even name them — this is the second layer.)
 * - `source: "api"` (the dashboard owner) → returns a single-use confirm token
 *   bound to {service, resourceId}. Nothing executes here; the caller must
 *   confirm via confirmStorageCommand to run it.
 *
 * Every result and audit row carries the operation's OWN tier
 * (classifyStorageCommand): 3 for the erase ops and for unrecognised ones, 2
 * for the recovery-key reveal and recording allocation changes.
 */
export async function evaluateStorageCommand(
  prisma: PrismaClient,
  service: string,
  resourceId: string,
  params?: Record<string, unknown>,
  userId?: string,
  source: "api" | "ai" = "api",
): Promise<EvaluateStorageResult> {
  const classification = classifyStorageCommand(service);
  const tier = classification.tier;

  // All storage writes + AI → hard block.
  if (source === "ai") {
    await logStorageCommandAudit(prisma, {
      userId,
      resourceId,
      service,
      params,
      tier: classification.tier,
      confirmed: false,
      blocked: true,
      reason: classification.reason,
    });
    return {
      allowed: false,
      blocked: true,
      reason:
        classification.reason ||
        `Storage operation '${service}' is not available via AI`,
      tier: classification.tier,
    };
  }

  // Dashboard (owner): mint a single-use confirm token bound to the exact
  // {service, resourceId}.
  if (pendingConfirmations.size >= STORAGE_MAX_PENDING_CONFIRMATIONS) {
    return {
      allowed: false,
      blocked: true,
      reason: "Too many pending storage confirmations — try again shortly",
      tier: classification.tier,
    };
  }
  const confirmationToken = randomBytes(32).toString("hex");
  pendingConfirmations.set(confirmationToken, {
    token: confirmationToken,
    service,
    resourceId,
    params,
    userId,
    tier: classification.tier,
    expiresAt: Date.now() + STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS,
  });

  await logStorageCommandAudit(prisma, {
    userId,
    resourceId,
    service,
    params,
    tier: classification.tier,
    confirmed: false,
    blocked: false,
    reason: classification.reason,
  });

  logger.info({ service, resourceId }, "Storage command requires confirmation");

  return {
    allowed: false,
    requiresConfirmation: true,
    confirmationToken,
    reason: classification.reason || "This storage operation requires confirmation",
    tier: classification.tier,
  };
}

/** Structured error codes returned by confirmStorageCommand. */
export type ConfirmStorageCommandError =
  | "TOKEN_MISSING"
  | "TOKEN_EXPIRED"
  | "TOKEN_USER_MISMATCH"
  | "TOKEN_OPERATION_MISMATCH"
  | "TOKEN_ENDPOINT_MISMATCH";

export interface ExpectedStorageConfirmation {
  service?: string;
  resourceId?: string;
  allowedServices?: ReadonlySet<string>;
}

/**
 * Confirm + consume a storage confirm token.
 *
 * The caller MUST echo the {service, resourceId} they think they are
 * confirming. Both must match the pending record exactly, or the request is
 * rejected with TOKEN_OPERATION_MISMATCH (WARP-41 defense generalised to the
 * {service, resourceId} binding). Single-use: the token is consumed whether or
 * not it matched-and-executed, and is gone on a second call.
 *
 * `expected.allowedServices` (WARP-3513) is checked LAST, after the requesting
 * user: a different user cannot burn the owner's token by presenting it at the
 * wrong endpoint, but the owner presenting it there loses it (a confused or
 * forged caller must start over). Nothing is audited as confirmed in that case:
 * nothing ran.
 */
export async function confirmStorageCommand(
  prisma: PrismaClient,
  confirmationToken: string,
  userId?: string,
  expected?: ExpectedStorageConfirmation,
): Promise<
  | { confirmed: true; service: string; resourceId: string; params?: Record<string, unknown> }
  | { confirmed: false; code: ConfirmStorageCommandError; reason: string }
> {
  const pending = pendingConfirmations.get(confirmationToken);
  if (!pending) {
    return {
      confirmed: false,
      code: "TOKEN_MISSING",
      reason: "Invalid or expired confirmation token",
    };
  }

  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(confirmationToken);
    return {
      confirmed: false,
      code: "TOKEN_EXPIRED",
      reason: "Confirmation token has expired",
    };
  }

  if (userId && pending.userId && userId !== pending.userId) {
    // Don't consume — a different user fat-fingering someone else's token
    // shouldn't burn it. (Same posture as network-safety.)
    return {
      confirmed: false,
      code: "TOKEN_USER_MISMATCH",
      reason: "Confirmation must come from the requesting user",
    };
  }

  // {service, resourceId} must match the minted token exactly. A mismatch is a
  // confused/forged caller — consume the token (single-use) and reject so it
  // can't be retried against the right resource.
  if (
    (expected?.service && expected.service !== pending.service) ||
    (expected?.resourceId && expected.resourceId !== pending.resourceId)
  ) {
    pendingConfirmations.delete(confirmationToken);
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: `Confirmation mismatch: token is for '${pending.service}' on '${pending.resourceId}'`,
    };
  }

  if (expected?.allowedServices && !expected.allowedServices.has(pending.service)) {
    pendingConfirmations.delete(confirmationToken);
    return {
      confirmed: false,
      code: "TOKEN_ENDPOINT_MISMATCH",
      reason: endpointMismatchReason(pending.service),
    };
  }

  // Consume (single-use).
  pendingConfirmations.delete(confirmationToken);

  await logStorageCommandAudit(prisma, {
    userId: userId || pending.userId,
    resourceId: pending.resourceId,
    service: pending.service,
    params: pending.params,
    tier: pending.tier,
    confirmed: true,
    blocked: false,
  });

  logger.info(
    { service: pending.service, resourceId: pending.resourceId },
    "Storage command confirmed",
  );

  return {
    confirmed: true,
    service: pending.service,
    resourceId: pending.resourceId,
    params: pending.params,
  };
}

// ── Audit logging (reuses CommandAuditLog like network-safety) ──

export async function logStorageCommandAudit(
  prisma: PrismaClient,
  entry: {
    userId?: string;
    resourceId: string;
    service: string;
    params?: Record<string, unknown>;
    tier?: SafetyTier;
    confirmed: boolean;
    blocked: boolean;
    reason?: string;
  },
): Promise<void> {
  try {
    await prisma.commandAuditLog.create({
      data: {
        userId: entry.userId || null,
        entityId: `storage.${entry.resourceId}`,
        domain: DOMAIN,
        service: entry.service,
        data: entry.params ? JSON.parse(JSON.stringify(entry.params)) : undefined,
        tier: entry.tier ?? 3,
        confirmed: entry.confirmed,
        blocked: entry.blocked,
        reason: entry.reason || null,
      },
    });
  } catch (err) {
    logger.error({ err, resourceId: entry.resourceId }, "Failed to write storage audit log");
  }
}

/**
 * Periodically clean expired confirmation tokens. Scheduled every 60 s by
 * index.ts main() on cron-runtime (WARP-3193 QUAL-7 — no timer at module
 * scope, so importing this module starts nothing).
 */
export function cleanupExpiredStorageTokens(): void {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmations) {
    if (now > pending.expiresAt) {
      pendingConfirmations.delete(token);
    }
  }
}
