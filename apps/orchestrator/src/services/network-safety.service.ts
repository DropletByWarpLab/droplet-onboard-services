/**
 * Network Safety Tier Service.
 *
 * Evaluates network commands through the safety tier system:
 * - Tier 1: Auto-execute (reads, SSID, channel, DNS)
 * - Tier 2: Requires user confirmation (firewall, password, WAN)
 * - Tier 3: Blocked for AI, web UI only (reboot, VPN)
 *
 * Follows the same pattern as safety-tier.service.ts.
 * Reuses the existing CommandAuditLog Prisma model.
 */

import { randomBytes } from "node:crypto";
import pino from "pino";
import { PrismaClient } from "@prisma/client";
import {
  classifyNetworkCommand,
  NETWORK_RATE_LIMIT_PER_ENTITY,
  NETWORK_RATE_LIMIT_WINDOW_MS,
  NETWORK_CONFIRMATION_TOKEN_EXPIRY_MS,
} from "../config/network-safety-rules.js";

const logger = pino({ name: "network-safety" });

interface PendingConfirmation {
  token: string;
  entityId: string;
  domain: string;
  operation: string;
  params?: Record<string, unknown>;
  userId?: string;
  tier: number;
  expiresAt: number;
}

/** In-memory rate limit tracking: entityId -> timestamps[] */
const rateLimitMap = new Map<string, number[]>();

/** In-memory pending confirmations: token -> PendingConfirmation */
const pendingConfirmations = new Map<string, PendingConfirmation>();

/**
 * Evaluate a network command through the safety tier system.
 */
export async function evaluateNetworkCommand(
  prisma: PrismaClient,
  entityId: string,
  operation: string,
  params?: Record<string, unknown>,
  userId?: string,
  source: "api" | "ai" = "api"
): Promise<
  | { allowed: true; tier: number }
  | { allowed: false; requiresConfirmation: true; confirmationToken: string; reason: string; tier: number }
  | { allowed: false; blocked: true; reason: string; tier: number }
> {
  const domain = entityId.split(".")[0] || "network";
  const classification = classifyNetworkCommand(operation, params);

  // Tier 3: Always blocked for AI, allowed for web UI with confirmation
  if (classification.tier === 3) {
    if (source === "ai") {
      await logNetworkCommand(prisma, {
        userId,
        entityId,
        domain,
        service: operation,
        data: params,
        tier: 3,
        confirmed: false,
        blocked: true,
        reason: classification.reason,
      });
      return {
        allowed: false,
        blocked: true,
        reason: classification.reason || `Operation '${operation}' is not available via AI`,
        tier: 3,
      };
    }
    // Web UI: treat as Tier 2 (needs confirmation)
    const confirmationToken = randomBytes(32).toString("hex");
    pendingConfirmations.set(confirmationToken, {
      token: confirmationToken,
      entityId,
      domain,
      operation,
      params,
      userId,
      tier: 3,
      expiresAt: Date.now() + NETWORK_CONFIRMATION_TOKEN_EXPIRY_MS,
    });

    await logNetworkCommand(prisma, {
      userId,
      entityId,
      domain,
      service: operation,
      data: params,
      tier: 3,
      confirmed: false,
      blocked: false,
      reason: classification.reason,
    });

    return {
      allowed: false,
      requiresConfirmation: true,
      confirmationToken,
      reason: classification.reason || "This operation requires confirmation",
      tier: 3,
    };
  }

  // Tier 1: Check rate limit then auto-execute
  if (!classification.requiresConfirmation) {
    const rateLimited = checkRateLimit(entityId);
    if (rateLimited) {
      await logNetworkCommand(prisma, {
        userId,
        entityId,
        domain,
        service: operation,
        data: params,
        tier: 1,
        confirmed: false,
        blocked: true,
        reason: "Rate limit exceeded",
      });
      return {
        allowed: false,
        blocked: true,
        reason: `Rate limit exceeded: max ${NETWORK_RATE_LIMIT_PER_ENTITY} commands per minute for ${entityId}`,
        tier: 1,
      };
    }

    recordRateLimitHit(entityId);
    await logNetworkCommand(prisma, {
      userId,
      entityId,
      domain,
      service: operation,
      data: params,
      tier: 1,
      confirmed: true,
      blocked: false,
    });
    return { allowed: true, tier: 1 };
  }

  // Tier 2: Requires confirmation
  const confirmationToken = randomBytes(32).toString("hex");
  pendingConfirmations.set(confirmationToken, {
    token: confirmationToken,
    entityId,
    domain,
    operation,
    params,
    userId,
    tier: classification.tier,
    expiresAt: Date.now() + NETWORK_CONFIRMATION_TOKEN_EXPIRY_MS,
  });

  await logNetworkCommand(prisma, {
    userId,
    entityId,
    domain,
    service: operation,
    data: params,
    tier: classification.tier,
    confirmed: false,
    blocked: false,
    reason: classification.reason,
  });

  logger.info(
    { entityId, operation, tier: classification.tier },
    "Network command requires confirmation"
  );

  return {
    allowed: false,
    requiresConfirmation: true,
    confirmationToken,
    reason: classification.reason || "This network command requires confirmation",
    tier: classification.tier,
  };
}

/**
 * Confirm a Tier 2/3 network command.
 */
export async function confirmNetworkCommand(
  prisma: PrismaClient,
  confirmationToken: string,
  userId?: string
): Promise<
  | { confirmed: true; entityId: string; domain: string; operation: string; params?: Record<string, unknown> }
  | { confirmed: false; reason: string }
> {
  const pending = pendingConfirmations.get(confirmationToken);
  if (!pending) {
    return { confirmed: false, reason: "Invalid or expired confirmation token" };
  }

  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(confirmationToken);
    return { confirmed: false, reason: "Confirmation token has expired (60s limit)" };
  }

  if (userId && pending.userId && userId !== pending.userId) {
    return { confirmed: false, reason: "Confirmation must come from the requesting user" };
  }

  pendingConfirmations.delete(confirmationToken);

  await logNetworkCommand(prisma, {
    userId: userId || pending.userId,
    entityId: pending.entityId,
    domain: pending.domain,
    service: pending.operation,
    data: pending.params,
    tier: pending.tier,
    confirmed: true,
    blocked: false,
  });

  logger.info(
    { entityId: pending.entityId, operation: pending.operation },
    "Network command confirmed"
  );

  return {
    confirmed: true,
    entityId: pending.entityId,
    domain: pending.domain,
    operation: pending.operation,
    params: pending.params,
  };
}

// ── Rate Limiting ──

function checkRateLimit(entityId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(entityId) || [];
  const recent = timestamps.filter((t) => now - t < NETWORK_RATE_LIMIT_WINDOW_MS);
  return recent.length >= NETWORK_RATE_LIMIT_PER_ENTITY;
}

function recordRateLimitHit(entityId: string): void {
  const now = Date.now();
  const timestamps = rateLimitMap.get(entityId) || [];
  const recent = timestamps.filter((t) => now - t < NETWORK_RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitMap.set(entityId, recent);
}

// ── Audit Logging ──

async function logNetworkCommand(
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
    logger.error({ err, entityId: entry.entityId }, "Failed to write network audit log");
  }
}

/**
 * Query network command audit log.
 */
export async function getNetworkAuditLog(
  prisma: PrismaClient,
  options: { entityId?: string; userId?: string; limit?: number; offset?: number } = {}
) {
  const { entityId, userId, limit = 50, offset = 0 } = options;
  const where: Record<string, unknown> = {
    domain: { in: ["network", "wireless", "firewall", "dhcp", "system"] },
  };
  if (entityId) where.entityId = entityId;
  if (userId) where.userId = userId;

  return prisma.commandAuditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
}

/** Periodically clean expired confirmation tokens and stale rate-limit entries. */
export function cleanupExpiredNetworkTokens(): void {
  const now = Date.now();
  for (const [token, pending] of pendingConfirmations) {
    if (now > pending.expiresAt) {
      pendingConfirmations.delete(token);
    }
  }
  for (const [key, timestamps] of rateLimitMap) {
    const recent = timestamps.filter((t) => now - t < NETWORK_RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, recent);
  }
}

// Schedule periodic cleanup
setInterval(cleanupExpiredNetworkTokens, 60_000);
