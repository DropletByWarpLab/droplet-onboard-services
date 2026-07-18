/**
 * Smart Home Safety Tier Service.
 *
 * Implements the three-tier safety framework from design doc Section 13.2:
 * - Tier 1: Auto-execute with parameter bounds + rate limiting
 * - Tier 2: Requires user confirmation (locks, alarms, extreme temps)
 * - Tier 3: All commands logged to audit trail
 */

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  classifyCommand,
  PARAMETER_BOUNDS,
  RATE_LIMIT_PER_ENTITY,
  RATE_LIMIT_WINDOW_MS,
  CONFIRMATION_TOKEN_EXPIRY_MS,
  type TierClassification,
} from "../config/safety-rules.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("safety-tier");

/**
 * WARP-353 (ADR-014 "Core mechanism — the target axis"): where a command
 * lands. `'self'` — the appliance itself (the pre-353 behaviour, and the
 * default everywhere). `{ kind: 'client', deviceId }` — a paired desktop
 * tool-host (`DeviceClient.id`); the Tier-2 confirmation surface is then
 * the target device's native modal (no dashboard /command/confirm
 * round-trip) and the signed `tool_response` validates consent.
 */
export type DispatchTarget = "self" | { kind: "client"; deviceId: string };

interface PendingConfirmation {
  token: string;
  entityId: string;
  domain: string;
  service: string;
  /**
   * KAN-7: the original device command to dispatch on confirm, when it
   * differs from the safety-classification `service` (e.g. the Matter command
   * `set_hvac_mode` maps to service `set_mode`). When omitted the command IS
   * the service (lock, set_temperature, …) — the pre-KAN-7 behaviour.
   */
  command?: string;
  data?: Record<string, unknown>;
  userId?: string;
  tier: number;
  expiresAt: number;
  /**
   * WARP-353: set when the token was minted for a client target. Binds the
   * confirmationToken to { service, action, resourceId, targetDeviceId }
   * per ADR-014 — a confirm that doesn't echo the same targetDeviceId
   * (including the dashboard round-trip, which never echoes one) is
   * rejected with TOKEN_OPERATION_MISMATCH. Absent for target 'self'.
   */
  targetDeviceId?: string;
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
  userId?: string,
  /**
   * KAN-7: the original device command, dispatched verbatim on confirm when it
   * differs from `service`. Defaults to `service` for the existing callers
   * where the two are identical.
   */
  command?: string,
  /**
   * WARP-353: where the command lands. Defaults to 'self' so every existing
   * caller keeps the pre-353 flow byte-for-byte. For a client target the
   * Tier-2 result carries `targetDeviceId` + `confirmationSurface: 'client'`
   * and the token only confirms when the same targetDeviceId is echoed.
   */
  target: DispatchTarget = "self"
): Promise<
  | { allowed: true; tier: number }
  | {
      allowed: false;
      requiresConfirmation: true;
      confirmationToken: string;
      reason: string;
      tier: number;
      /** WARP-353: present iff the command targets a paired client. */
      targetDeviceId?: string;
      /** WARP-353: 'client' iff the confirm surface is the target device's native modal. */
      confirmationSurface?: "client";
    }
  | { allowed: false; blocked: true; reason: string; tier: number }
> {
  const targetDeviceId = target === "self" ? undefined : target.deviceId;
  const domain = entityId.split(".")[0];
  const classification = classifyCommand(domain, service, data);

  // WARP-353 (ADR-014 ②): Tier-3-blocked actions never reach a confirmation
  // path — get_clipboard / screenshot / anything outside the V1 client-tool
  // whitelist is refused outright until the deep-assist ADR (WARP-549) lands.
  if (classification.blockedForAi) {
    await logCommand(prisma, {
      userId,
      entityId,
      domain,
      service,
      data,
      tier: classification.tier,
      confirmed: false,
      blocked: true,
      reason: classification.reason ?? "Blocked for AI",
      targetDeviceId,
    });
    return {
      allowed: false,
      blocked: true,
      reason: classification.reason ?? "This action is blocked for AI",
      tier: classification.tier,
    };
  }

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
        targetDeviceId,
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
          targetDeviceId,
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
      targetDeviceId,
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
    command: command ?? service,
    data,
    userId,
    tier: classification.tier,
    expiresAt: Date.now() + CONFIRMATION_TOKEN_EXPIRY_MS,
    targetDeviceId,
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
    targetDeviceId,
  });

  logger.info(
    { entityId, domain, service, tier: classification.tier, targetDeviceId },
    "Command requires confirmation"
  );

  // WARP-353: the extra target fields are only present for client targets so
  // the self-target 202 body (JSON-serialized by matter.ts et al.) stays
  // byte-for-byte identical to the pre-353 shape.
  return {
    allowed: false,
    requiresConfirmation: true,
    confirmationToken,
    reason: classification.reason || "This command requires confirmation",
    tier: classification.tier,
    ...(targetDeviceId !== undefined
      ? { targetDeviceId, confirmationSurface: "client" as const }
      : {}),
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
 * Callers MUST echo the `expected.service` (and optionally `expected.entityId`
 * or `expected.nodeId`) from the original 202 response. If the server's pending
 * record doesn't match, the request is rejected with `TOKEN_OPERATION_MISMATCH`.
 * See WARP-41.
 *
 * `expected.nodeId` binds the token to a node using only the mint-time
 * entityId (`<domain>.<nodeId>`). Confirm paths must use this instead of
 * reconstructing the full entityId from live device state — a device that is
 * offline or mid-reconnect reports a degraded category, and a rebuilt
 * entityId would mismatch the token minted seconds earlier.
 *
 * WARP-353: `expected.targetDeviceId` is checked BOTH ways — a token minted
 * for a client target only confirms when the same targetDeviceId is echoed
 * (the dashboard round-trip never echoes one, so it can't confirm a client
 * token), and a self-minted token rejects any targetDeviceId echo. The
 * client-target confirm path is the verified signed `tool_response`
 * (client-dispatch.service.ts), never a dashboard call.
 */
export async function confirmCommand(
  prisma: PrismaClient,
  confirmationToken: string,
  userId?: string,
  expected?: {
    service?: string;
    entityId?: string;
    nodeId?: string;
    /** WARP-353: required echo for tokens minted with a client target. */
    targetDeviceId?: string;
  }
): Promise<
  | {
      confirmed: true;
      entityId: string;
      domain: string;
      service: string;
      /** KAN-7: the device command to dispatch (may differ from `service`). */
      command: string;
      data?: Record<string, unknown>;
      /** WARP-353: present iff the token was minted for a client target. */
      targetDeviceId?: string;
    }
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
  if (expected?.nodeId) {
    const pendingNodeId = pending.entityId.slice(
      pending.entityId.indexOf(".") + 1
    );
    if (pendingNodeId !== expected.nodeId) {
      return {
        confirmed: false,
        code: "TOKEN_OPERATION_MISMATCH",
        reason: `Confirmation node mismatch: token was minted for node '${pendingNodeId}', got '${expected.nodeId}'`,
      };
    }
  }
  // WARP-353: target binding is checked in BOTH directions. A client-minted
  // token demands the exact targetDeviceId echo (so the dashboard confirm,
  // which never sends one, cannot confirm it); a self-minted token rejects
  // any echo (so a client response can't confirm an appliance command).
  if ((pending.targetDeviceId ?? null) !== (expected?.targetDeviceId ?? null)) {
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: pending.targetDeviceId
        ? `Confirmation target mismatch: token was minted for client device '${pending.targetDeviceId}'`
        : "Confirmation target mismatch: token was minted for target 'self'",
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
    command: pending.command,
    data: pending.data,
    tier: pending.tier,
    confirmed: true,
    blocked: false,
    targetDeviceId: pending.targetDeviceId,
  });

  logger.info(
    {
      entityId: pending.entityId,
      service: pending.service,
      command: pending.command,
      targetDeviceId: pending.targetDeviceId,
    },
    "Command confirmed and executing"
  );

  return {
    confirmed: true,
    entityId: pending.entityId,
    domain: pending.domain,
    service: pending.service,
    command: pending.command ?? pending.service,
    data: pending.data,
    ...(pending.targetDeviceId !== undefined
      ? { targetDeviceId: pending.targetDeviceId }
      : {}),
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
    /** The concrete dispatched command when it differs from service (e.g. set_hvac_mode vs set_mode). */
    command?: string;
    data?: Record<string, unknown>;
    tier: number;
    confirmed: boolean;
    blocked: boolean;
    reason?: string;
    /**
     * WARP-353: the client device a command targets. Folded into the data
     * JSON as `_targetDeviceId` (same no-migration pattern as KAN-7's
     * `_command`) — the dedicated per-device audit axis (signed ActivityRow
     * chain columns) is WARP-1299.
     */
    targetDeviceId?: string;
  }
): Promise<void> {
  try {
    // When command differs from service (KAN-7+), fold it into the data JSON so
    // the audit record captures the concrete sidecar call without a schema migration.
    let auditData =
      entry.command && entry.command !== entry.service
        ? { ...(entry.data ?? {}), _command: entry.command }
        : entry.data;
    if (entry.targetDeviceId !== undefined) {
      auditData = { ...(auditData ?? {}), _targetDeviceId: entry.targetDeviceId };
    }
    await prisma.commandAuditLog.create({
      data: {
        userId: entry.userId || null,
        entityId: entry.entityId,
        domain: entry.domain,
        service: entry.service,
        data: auditData ? JSON.parse(JSON.stringify(auditData)) : undefined,
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
