/**
 * Smart Home Safety Tier Service.
 *
 * Implements the three-tier safety framework from design doc Section 13.2:
 * - Tier 1: Auto-execute with parameter bounds + rate limiting
 * - Tier 2: Requires user confirmation (locks, alarms, extreme temps)
 * - Tier 3: All commands logged to audit trail
 */

import { randomBytes } from "node:crypto";
import pino from "pino";
import { PrismaClient } from "@prisma/client";
import {
  classifyCommand,
  PARAMETER_BOUNDS,
  RATE_LIMIT_PER_ENTITY,
  RATE_LIMIT_WINDOW_MS,
  CONFIRMATION_TOKEN_EXPIRY_MS,
  type TierClassification,
} from "../config/safety-rules.js";

const logger = pino({ name: "safety-tier" });

interface PendingConfirmation {
  token: string;
  entityId: string;
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  userId?: string;
  tier: number;
  expiresAt: number;
}

/** In-memory rate limit tracking: entityId -> timestamps[] */
const rateLimitMap = new Map<string, number[]>();

/** In-memory pending confirmations: token -> PendingConfirmation */
const pendingConfirmations = new Map<string, PendingConfirmation>();

/**
 * Evaluate a smart home command through the safety tier system.
 *
 * Returns either { allowed: true } for Tier 1 auto-execute,
 * or { requiresConfirmation: true, confirmationToken, reason } for Tier 2.
 * All commands are logged (Tier 3) regardless of tier.
 */
export async function evaluateCommand(
  prisma: PrismaClient,
  entityId: string,
  service: string,
  data?: Record<string, unknown>,
  userId?: string
): Promise<
  | { allowed: true; tier: number }
  | { allowed: false; requiresConfirmation: true; confirmationToken: string; reason: string; tier: number }
  | { allowed: false; blocked: true; reason: string; tier: number }
> {
  const domain = entityId.split(".")[0];
  const classification = classifyCommand(domain, service, data);

  // Tier 1: Check rate limit
  if (!classification.requiresConfirmation) {
    const rateLimited = checkRateLimit(entityId);
    if (rateLimited) {
      await logCommand(prisma, {
        userId,
        entityId,
        domain,
        service,
        data,
        tier: classification.tier,
        confirmed: false,
        blocked: true,
        reason: "Rate limit exceeded",
      });
      return {
        allowed: false,
        blocked: true,
        reason: `Rate limit exceeded: max ${RATE_LIMIT_PER_ENTITY} commands per minute for ${entityId}`,
        tier: classification.tier,
      };
    }

    // Tier 1: Check parameter bounds
    const boundsKey = `${domain}.${service}`;
    const bounds = PARAMETER_BOUNDS[boundsKey];
    if (bounds && data) {
      const value = data[bounds.field] as number | undefined;
      if (value !== undefined && (value < bounds.min || value > bounds.max)) {
        await logCommand(prisma, {
          userId,
          entityId,
          domain,
          service,
          data,
          tier: classification.tier,
          confirmed: false,
          blocked: true,
          reason: `Parameter ${bounds.field} out of bounds: ${value} (allowed: ${bounds.min}-${bounds.max})`,
        });
        return {
          allowed: false,
          blocked: true,
          reason: `Parameter '${bounds.field}' value ${value} is out of allowed range [${bounds.min}, ${bounds.max}]`,
          tier: classification.tier,
        };
      }
    }

    // Tier 1: Auto-execute — record rate limit hit and log
    recordRateLimitHit(entityId);
    await logCommand(prisma, {
      userId,
      entityId,
      domain,
      service,
      data,
      tier: classification.tier,
      confirmed: true,
      blocked: false,
    });
    return { allowed: true, tier: classification.tier };
  }

  // Tier 2: Requires confirmation — generate token
  const confirmationToken = randomBytes(32).toString("hex");
  pendingConfirmations.set(confirmationToken, {
    token: confirmationToken,
    entityId,
    domain,
    service,
    data,
    userId,
    tier: classification.tier,
    expiresAt: Date.now() + CONFIRMATION_TOKEN_EXPIRY_MS,
  });

  await logCommand(prisma, {
    userId,
    entityId,
    domain,
    service,
    data,
    tier: classification.tier,
    confirmed: false,
    blocked: false,
    reason: classification.reason,
  });

  logger.info(
    { entityId, domain, service, tier: classification.tier },
    "Command requires confirmation"
  );

  return {
    allowed: false,
    requiresConfirmation: true,
    confirmationToken,
    reason: classification.reason || "This command requires confirmation",
    tier: classification.tier,
  };
}

/** Structured error codes returned by `confirmCommand` (WARP-41). */
export type ConfirmCommandError =
  | "TOKEN_MISSING"
  | "TOKEN_EXPIRED"
  | "TOKEN_OPERATION_MISMATCH";

/**
 * Confirm a Tier 2 command and return the original command details.
 *
 * Callers MUST echo the `expected.service` (and optionally `expected.entityId`)
 * from the original 202 response. If the server's pending record doesn't match,
 * the request is rejected with `TOKEN_OPERATION_MISMATCH`. See WARP-41.
 */
export async function confirmCommand(
  prisma: PrismaClient,
  confirmationToken: string,
  userId?: string,
  expected?: { service?: string; entityId?: string }
): Promise<
  | { confirmed: true; entityId: string; domain: string; service: string; data?: Record<string, unknown> }
  | { confirmed: false; code: ConfirmCommandError; reason: string }
> {
  const pending = pendingConfirmations.get(confirmationToken);
  if (!pending) {
    return {
      confirmed: false,
      code: "TOKEN_MISSING",
      reason: "Invalid or expired confirmation token",
    };
  }

  // Check expiry
  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(confirmationToken);
    return {
      confirmed: false,
      code: "TOKEN_EXPIRED",
      reason: "Confirmation token has expired (60s limit)",
    };
  }

  // WARP-41: reject mismatched echo so a caller can't confirm the wrong op.
  if (expected?.service && expected.service !== pending.service) {
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: `Confirmation service mismatch: expected '${pending.service}', got '${expected.service}'`,
    };
  }
  if (expected?.entityId && expected.entityId !== pending.entityId) {
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: `Confirmation entityId mismatch: expected '${pending.entityId}', got '${expected.entityId}'`,
    };
  }

  // Remove from pending (single-use)
  pendingConfirmations.delete(confirmationToken);

  // Log the confirmed execution
  await logCommand(prisma, {
    userId: userId || pending.userId,
    entityId: pending.entityId,
    domain: pending.domain,
    service: pending.service,
    data: pending.data,
    tier: pending.tier,
    confirmed: true,
    blocked: false,
  });

  logger.info(
    { entityId: pending.entityId, service: pending.service },
    "Command confirmed and executing"
  );

  return {
    confirmed: true,
    entityId: pending.entityId,
    domain: pending.domain,
    service: pending.service,
    data: pending.data,
  };
}

// ── Rate Limiting ──

function checkRateLimit(entityId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(entityId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  return recent.length >= RATE_LIMIT_PER_ENTITY;
}

function recordRateLimitHit(entityId: string): void {
  const now = Date.now();
  const timestamps = rateLimitMap.get(entityId) || [];
  // Prune old entries
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitMap.set(entityId, recent);
}

// ── Audit Logging ──

async function logCommand(
  prisma: PrismaClient,
  entry: {
    userId?: string;
    entityId: string;
    domain: string;
    service: string;
    data?: Record<string, unknown>;
    tier: number;
    confirmed: boolean;
    blocked: boolean;
    reason?: string;
  }
): Promise<void> {
  try {
    await prisma.commandAuditLog.create({
      data: {
        userId: entry.userId || null,
        entityId: entry.entityId,
        domain: entry.domain,
        service: entry.service,
        data: entry.data ? JSON.parse(JSON.stringify(entry.data)) : undefined,
        tier: entry.tier,
        confirmed: entry.confirmed,
        blocked: entry.blocked,
        reason: entry.reason || null,
      },
    });
  } catch (err) {
    // Non-fatal — don't block command execution for logging failures
    logger.error({ err, entityId: entry.entityId }, "Failed to write audit log");
  }
}

/**
 * Query the command audit log.
 */
export async function getAuditLog(
  prisma: PrismaClient,
  options: { entityId?: string; userId?: string; limit?: number; offset?: number } = {}
) {
  const { entityId, userId, limit = 50, offset = 0 } = options;
  const where: Record<string, string> = {};
  if (entityId) where.entityId = entityId;
  if (userId) where.userId = userId;

  return prisma.commandAuditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}

// ── Cleanup ──

/** Periodically clean expired confirmation tokens (call from setInterval). */
export function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmations) {
    if (now > pending.expiresAt) {
      pendingConfirmations.delete(token);
    }
  }
}
