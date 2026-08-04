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
import { PrismaClient } from "@prisma/client";
import {
  classifyNetworkCommand,
  NETWORK_RATE_LIMIT_PER_ENTITY,
  NETWORK_RATE_LIMIT_WINDOW_MS,
  NETWORK_CONFIRMATION_TOKEN_EXPIRY_MS,
} from "../config/network-safety-rules.js";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { createLogger } from "../lib/logger.js";
import { redactSecretParams } from "../lib/log-redaction.js";

const logger = createLogger("network-safety");

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
const MAX_PENDING_CONFIRMATIONS = 1000;

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
        source,
      });
      return {
        allowed: false,
        blocked: true,
        reason: classification.reason || `Operation '${operation}' is not available via AI`,
        tier: 3,
      };
    }
    // Web UI: treat as Tier 2 (needs confirmation)
    if (pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) {
      return { allowed: false, blocked: true, reason: "Too many pending confirmations", tier: 3 };
    }
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
      source,
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
        source,
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
      source,
    });
    return { allowed: true, tier: 1 };
  }

  // Tier 2: Requires confirmation
  if (pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) {
    return { allowed: false, blocked: true, reason: "Too many pending confirmations", tier: classification.tier };
  }
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
    source,
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

/** Structured error codes returned by `confirmNetworkCommand` (WARP-41). */
export type ConfirmNetworkCommandError =
  | "TOKEN_MISSING"
  | "TOKEN_EXPIRED"
  | "TOKEN_USER_MISMATCH"
  | "TOKEN_OPERATION_MISMATCH";

/**
 * Confirm a Tier 2/3 network command.
 *
 * The caller MUST echo back the `expectedOperation` (and optionally
 * `expectedEntityId`) that they think they're confirming. If the server's
 * pending record doesn't match, the request is rejected with
 * `TOKEN_OPERATION_MISMATCH` — this prevents a confused dashboard from
 * confirming the wrong pending operation when multiple are in flight.
 * See WARP-41.
 */
export async function confirmNetworkCommand(
  prisma: PrismaClient,
  confirmationToken: string,
  userId?: string,
  expected?: { operation?: string; entityId?: string }
): Promise<
  | { confirmed: true; entityId: string; domain: string; operation: string; params?: Record<string, unknown> }
  | { confirmed: false; code: ConfirmNetworkCommandError; reason: string }
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
      reason: "Confirmation token has expired (60s limit)",
    };
  }

  // Confirmer-identity check. Two distinct cases:
  //
  //  1. USER-minted op (pending.userId is a real human, e.g. "u-owner"):
  //     the SAME human must confirm. This is the original guard and stays
  //     intact — no regression for ops a person initiates from the dashboard
  //     (add_port_forward via the form, etc.), which both mint and confirm
  //     under that one human id.
  //
  //  2. SERVICE-minted op (pending.userId starts with "_service:", e.g. the
  //     agent dispatching share_clip / add_port_forward through the MCP
  //     principal): the agent PROPOSES, a human DISPOSES. The service
  //     principal can never sign/execute its own pending op, so the
  //     same-id rule would dead-end the legitimate completion path
  //     (TOKEN_USER_MISMATCH on every human confirm). Instead, an AUTHORIZED
  //     human may confirm it — the route's own requireRole/requireRoleOrMcp
  //     guard has already established the confirmer is owner/admin (per the
  //     op's role tier) and is NOT itself a service principal. We re-assert
  //     the latter here as defense-in-depth: a "_service:*" confirmer is
  //     barred so the agent can never self-approve even if a confirm route
  //     ever admitted it. See network-mcp-service-rbac.test.ts and
  //     clips-share-confirmation.routes.test.ts.
  const isServiceMinted =
    typeof pending.userId === "string" && pending.userId.startsWith("_service:");
  const isServiceConfirmer =
    typeof userId === "string" && userId.startsWith("_service:");

  if (isServiceMinted) {
    if (isServiceConfirmer) {
      // The service principal (agent) cannot confirm its own — or any —
      // service-minted op. Only a human disposes.
      return {
        confirmed: false,
        code: "TOKEN_USER_MISMATCH",
        reason: "Confirmation must come from a signed-in user, not the assistant",
      };
    }
    // Authorized human confirming an agent-proposed op — allowed. The
    // route-level role guard is the authorization tier.
  } else if (userId && pending.userId && userId !== pending.userId) {
    return {
      confirmed: false,
      code: "TOKEN_USER_MISMATCH",
      reason: "Confirmation must come from the requesting user",
    };
  }

  // WARP-41: reject if the caller is confirming a different operation than
  // the one this token was issued for. The token on its own isn't enough —
  // the echoed operation has to match.
  if (expected?.operation && expected.operation !== pending.operation) {
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: `Confirmation operation mismatch: expected '${pending.operation}', got '${expected.operation}'`,
    };
  }
  if (expected?.entityId && expected.entityId !== pending.entityId) {
    return {
      confirmed: false,
      code: "TOKEN_OPERATION_MISMATCH",
      reason: `Confirmation entityId mismatch: expected '${pending.entityId}', got '${expected.entityId}'`,
    };
  }

  pendingConfirmations.delete(confirmationToken);

  await logNetworkCommand(prisma, {
    // A confirm always comes from the web UI (the agent can never
    // self-approve — see the guard above), so this row is user-sourced.
    userId: userId || pending.userId,
    entityId: pending.entityId,
    domain: pending.domain,
    service: pending.operation,
    data: pending.params,
    tier: pending.tier,
    confirmed: true,
    blocked: false,
    source: "api",
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
    /** WARP-181: which surface issued the op — drives actor attribution. */
    source?: "api" | "ai";
    reason?: string;
  }
): Promise<void> {
  // WARP-1718: redact ONCE, up front, so no writer below can reach the raw
  // params. Several Tier-2 ops carry household secrets in `data` —
  // set_wifi_password `{iface_section, password}`, create_guest_network
  // `{radio, ssid, password, network}`, and camera_subnet_setup, which
  // forwards `req.body` wholesale. Those params legitimately ride the
  // in-memory pending-confirmation record (the Tier-2 confirm runs in a
  // separate request and the network-status dispatcher replays them), so the
  // LOGGING boundary is the only correct place to strip them. The key stays
  // put with a placeholder value: the audit still shows a secret was set.
  const safeData = redactSecretParams(entry.data);

  try {
    await prisma.commandAuditLog.create({
      data: {
        userId: entry.userId || null,
        entityId: entry.entityId,
        domain: entry.domain,
        service: entry.service,
        data: safeData ? JSON.parse(JSON.stringify(safeData)) : undefined,
        tier: entry.tier,
        confirmed: entry.confirmed,
        blocked: entry.blocked,
        reason: entry.reason || null,
      },
    });
  } catch (err) {
    logger.error({ err, entityId: entry.entityId }, "Failed to write network audit log");
  }

  // WARP-456: dual-write into the signed activity chain. CommandAuditLog
  // becomes a read view going forward (per spec AC8); writes here keep
  // legacy queries (admin-claude-activity route) working while
  // ActivityRow becomes the canonical audit table the dashboard reads.
  const severity = entry.blocked
    ? "warn"
    : entry.confirmed
      ? "ok"
      : "info";
  // WARP-181: actor attribution. `entry.userId` is req.user.id from the
  // route layer — a canonical user UUID, or a "_service:*" principal id
  // when the op came through the MCP/agent channel. Service principals
  // and source==="ai" ops are the AI acting; a human UUID under the api
  // source is the user themselves.
  const isServicePrincipal =
    typeof entry.userId === "string" && entry.userId.startsWith("_service:");
  const onBehalfOfId = entry.userId && !isServicePrincipal ? entry.userId : null;
  const actor: ActivityActor =
    entry.source === "ai" || isServicePrincipal
      ? { type: "ai", id: onBehalfOfId }
      : onBehalfOfId
        ? { type: "user", id: onBehalfOfId }
        : { type: "anonymous" };

  await recordActivity({
    kind: "network",
    severity,
    sourceIcon: "wifi",
    actor,
    what: entry.blocked
      ? `Network ${entry.service} blocked`
      : entry.confirmed
        ? `Network ${entry.service}`
        : `Network ${entry.service} pending`,
    sub: `tier ${entry.tier} • ${entry.entityId}`,
    // WARP-1718: `refs` deliberately carries NO command params. The signed
    // activity chain is append-only and tamper-evident — a secret written
    // here cannot be rewritten out later without breaking the chain. If a
    // future change needs params on the row, pass `safeData`, never
    // `entry.data`.
    refs: {
      entityId: entry.entityId,
      domain: entry.domain,
      service: entry.service,
      tier: entry.tier,
      confirmed: entry.confirmed,
      blocked: entry.blocked,
      userId: entry.userId ?? null,
      reason: entry.reason ?? null,
    },
  });
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
    domain: { in: ["network", "wireless", "firewall", "dhcp", "system", "switch", "camera"] },
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
