/**
 * The webhook delivery worker (WARP-3532, ADR-069 §9).
 *
 * `PmWebhookDelivery` IS the queue: the fan-out inserts rows, this drains them on
 * a `cron-runtime` interval (index.ts). There is no job table beside it and no
 * process-local state a restart could lose.
 *
 * ── THE ONE DIAL SITE ──────────────────────────────────────────────────────
 *
 * `attemptDelivery` is the only function in this program that opens a socket to
 * a customer-configured address, and every path reaches it: the worker's sweep,
 * the "send test" button, a re-delivery (which is just a new row). Everything
 * that makes the dial safe happens inside it, in this order, so no caller can
 * skip a step:
 *
 *   1. the webhook must still be ACTIVE (a test excepted) and the row not expired;
 *   2. `resolvePinnedDestination` — SSRF guard: resolve once, vet every answer,
 *      refuse loopback / link-local / multicast / metadata / this box;
 *   3. an OFF-LAN destination needs the owner's `work_integrations` switch
 *      (`workIntegrationsGate`); a LAN destination does not;
 *   4. sign the exact bytes, then send to the pinned address — no redirects.
 *
 * ── RETRIES ────────────────────────────────────────────────────────────────
 *
 * 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h after the first failure: eight
 * attempts, then GIVEN_UP. A delivery older than 48 hours is dropped whatever
 * state it is in, so a webhook the owner never switched the egress setting on
 * for does not queue forever. The webhook itself is turned off after 20 failed
 * attempts in a row (any success resets the count) and the owners and admins are
 * told; its queued deliveries are then given up rather than held, so turning it
 * back on does not replay a week-old burst.
 *
 * A destination that is OFF-LAN while the switch is off is not a failure and is
 * not retried on the ladder: the row stays PENDING with "Blocked by egress
 * setting" and is looked at again a minute later, so flipping the switch delivers
 * within about a minute.
 *
 * ── AT-LEAST-ONCE ──────────────────────────────────────────────────────────
 *
 * A worker that dies after the receiver answered and before the row says
 * DELIVERED sends it again once the lease runs out. Receivers de-duplicate on the
 * payload's `id` (docs/work-webhooks.md).
 */
import type { PmWebhook, PmWebhookDelivery, PrismaClient } from "@prisma/client";
import { createLogger } from "../../lib/logger.js";
import { pinnedFetch } from "../../lib/outbound-pinned-fetch.js";
import { webhookLocalNetworkFacts } from "./webhook-local-network.js";
import {
  isOutboundUrlBlocked,
  resolvePinnedDestination,
  type PinnedDestination,
} from "../../lib/outbound-url-guard.js";
import { workIntegrationsGate } from "../off-lan-gate.service.js";
import { notifyOwnersAndAdmins } from "../notifications.service.js";
import { renderWebhookBody } from "./webhook-formats.js";
import type { WebhookPayloadV1 } from "./webhook-payload.js";
import { openWebhookSecret } from "./webhook-secret.js";
import { openWebhookUrl } from "./webhook-url.js";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signWebhookBody } from "./webhook-signature.js";

const defaultLogger = createLogger("pm-webhook-delivery");

/** After the first attempt fails, wait this long before each next one. */
export const RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 3_600_000, // 2 h
  6 * 3_600_000, // 6 h
  12 * 3_600_000, // 12 h
  24 * 3_600_000, // 24 h
];
/** The first attempt plus one per delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Consecutive failed attempts that turn a webhook off. */
export const DISABLE_AFTER_FAILURES = 20;
/** A delivery older than this is dropped whatever state it is in. */
export const DELIVERY_EXPIRY_MS = 48 * 3_600_000;
/** Claimed rows are leased this long; it must outlast a whole sweep. */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** How often a delivery blocked by the egress switch is looked at again. */
export const BLOCKED_RECHECK_MS = 60_000;
/** Rows claimed per sweep, and how many are in flight at once. */
export const DELIVERY_BATCH = 20;
export const DELIVERY_CONCURRENCY = 5;
/** The delivery log keeps finished rows this long. */
export const DELIVERY_RETENTION_MS = 30 * 24 * 3_600_000;

/**
 * What `PmWebhookDelivery.lastError` says. Fixed sentences, never built from the
 * URL, the host, an address or a response body: the delivery log is shown to the
 * owner and an error that quoted the destination would be a probe oracle.
 */
export const DELIVERY_ERRORS = {
  EGRESS_BLOCKED: "Blocked by egress setting",
  DESTINATION_NOT_ALLOWED: "Destination not allowed",
  UNRESOLVABLE: "Could not find that host",
  UNREACHABLE: "Host unreachable",
  CONNECTION_REFUSED: "Connection refused",
  CONNECTION_RESET: "Connection reset",
  TIMED_OUT: "Timed out",
  TLS: "TLS certificate not trusted",
  COULD_NOT_CONNECT: "Could not connect",
  SECRET_UNREADABLE: "Signing secret could not be read",
  EXPIRED: "Expired before it could be delivered",
  WEBHOOK_OFF: "Webhook was turned off",
} as const;

/** Map whatever the dial threw onto one of the fixed sentences. */
export function describeFailure(err: unknown): string {
  if (isOutboundUrlBlocked(err)) {
    return err.reason === "unresolvable"
      ? DELIVERY_ERRORS.UNRESOLVABLE
      : DELIVERY_ERRORS.DESTINATION_NOT_ALLOWED;
  }
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code ?? e?.code ?? "";
  const name = e?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError" || /TIMEOUT|TIMEDOUT/.test(code)) {
    return DELIVERY_ERRORS.TIMED_OUT;
  }
  if (code === "ECONNREFUSED") return DELIVERY_ERRORS.CONNECTION_REFUSED;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return DELIVERY_ERRORS.CONNECTION_RESET;
  if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/.test(code)) return DELIVERY_ERRORS.TLS;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return DELIVERY_ERRORS.UNRESOLVABLE;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return DELIVERY_ERRORS.UNREACHABLE;
  return DELIVERY_ERRORS.COULD_NOT_CONNECT;
}

type DeliveryPrisma = Pick<PrismaClient, "pmWebhook" | "pmWebhookDelivery" | "$transaction">;

export type DeliveryWithWebhook = PmWebhookDelivery & { webhook: PmWebhook };

export interface DeliveryLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface DeliveryDeps {
  now?: () => Date;
  /** The SSRF guard. Tests that dial a loopback receiver replace it. */
  resolveDestination?: (url: string) => Promise<PinnedDestination>;
  /** The socket. */
  send?: typeof pinnedFetch;
  /** `work_integrations`. Read at most once per sweep. */
  gate?: () => Promise<boolean>;
  /** Tells the owners and admins a webhook was turned off. */
  notifyAdmins?: (title: string, body: string) => Promise<unknown>;
  logger?: DeliveryLogger;
}

export type DeliveryOutcome =
  | "delivered"
  | "retry"
  | "gave_up"
  | "blocked"
  | "expired"
  | "webhook_off";

interface ResolvedDeps {
  now: () => Date;
  resolveDestination: (url: string) => Promise<PinnedDestination>;
  send: typeof pinnedFetch;
  gate: () => Promise<boolean>;
  notifyAdmins: (title: string, body: string) => Promise<unknown>;
  logger: DeliveryLogger;
}

/** Wire the production defaults under whatever a caller overrode. */
export function resolveDeliveryDeps(prisma: PrismaClient, deps: DeliveryDeps = {}): ResolvedDeps {
  return {
    now: deps.now ?? (() => new Date()),
    resolveDestination:
      deps.resolveDestination ??
      ((url) => resolvePinnedDestination(url, { local: () => webhookLocalNetworkFacts() })),
    send: deps.send ?? pinnedFetch,
    gate: deps.gate ?? (() => workIntegrationsGate(prisma)),
    notifyAdmins: deps.notifyAdmins ?? ((title, body) => notifyOwnersAndAdmins(prisma, title, body)),
    logger: deps.logger ?? defaultLogger,
  };
}

const OWED = ["PENDING", "FAILED"] as const;

/**
 * Claim up to `limit` due rows and lease them. `FOR UPDATE SKIP LOCKED` is the
 * exclusion (two replicas never take the same row); moving `nextAttemptAt`
 * forward is the lease, so a worker that dies mid-send is retried after
 * `DELIVERY_LEASE_MS` instead of leaving a row nobody will touch. Oldest due
 * first.
 */
export async function claimDueDeliveries(
  prisma: Pick<PrismaClient, "$transaction">,
  now: Date,
  limit: number = DELIVERY_BATCH,
): Promise<DeliveryWithWebhook[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "PmWebhookDelivery"
      WHERE "status" IN ('PENDING', 'FAILED')
        AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.pmWebhookDelivery.updateMany({
      where: { id: { in: ids } },
      data: { nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS) },
    });
    return tx.pmWebhookDelivery.findMany({
      where: { id: { in: ids } },
      include: { webhook: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });
}

/**
 * Write a delivery's outcome. Guarded on the row still being owed an attempt —
 * if it was deleted (its webhook went) or settled by another path in the
 * meantime, this writes nothing rather than overwrite it.
 */
async function settle(
  prisma: DeliveryPrisma,
  id: string,
  data: Parameters<DeliveryPrisma["pmWebhookDelivery"]["updateMany"]>[0]["data"],
): Promise<void> {
  await prisma.pmWebhookDelivery.updateMany({
    where: { id, status: { in: [...OWED] } },
    data,
  });
}

async function recordWebhookFailure(
  prisma: DeliveryPrisma,
  hook: PmWebhook,
  deps: ResolvedDeps,
): Promise<void> {
  await prisma.pmWebhook.updateMany({
    where: { id: hook.id },
    data: { consecutiveFailures: { increment: 1 } },
  });
  // Guarded on ACTIVE and on the count: exactly one failing attempt flips it, so
  // exactly one notification goes out however many deliveries fail together.
  const off = await prisma.pmWebhook.updateMany({
    where: { id: hook.id, status: "ACTIVE", consecutiveFailures: { gte: DISABLE_AFTER_FAILURES } },
    data: { status: "DISABLED_FAILING", enabled: false },
  });
  if (off.count !== 1) return;
  deps.logger.warn(
    { webhookId: hook.id, failures: DISABLE_AFTER_FAILURES },
    "pm-webhook: turned off after repeated failures",
  );
  const name = hook.name.length > 60 ? `${hook.name.slice(0, 59)}…` : hook.name;
  try {
    await deps.notifyAdmins(
      `Work notifications turned off: ${name}`,
      `Droplet could not deliver to this destination ${DISABLE_AFTER_FAILURES} times in a row, so it stopped sending. ` +
        "Check the address, then turn it back on under Settings, Connectors, Work notifications.",
    );
  } catch (err) {
    deps.logger.error({ err, webhookId: hook.id }, "pm-webhook: could not notify admins that a webhook was turned off");
  }
}

/**
 * One attempt at one delivery. See the module header: this is the only dial.
 *
 * `mode.test` is the "send test" button: one attempt, no retries (a failed test
 * is GIVEN_UP, not queued), no effect on the webhook's failure count, and it runs
 * even on a webhook that is paused — debugging a paused webhook is the point.
 */
export async function attemptDelivery(
  prisma: DeliveryPrisma,
  delivery: DeliveryWithWebhook,
  mode: { test?: boolean },
  deps: ResolvedDeps,
): Promise<DeliveryOutcome> {
  const now = deps.now();
  const hook = delivery.webhook;
  const test = mode.test === true;

  const giveUp = async (lastError: string): Promise<void> =>
    settle(prisma, delivery.id, { status: "GIVEN_UP", lastError, nextAttemptAt: now });

  if (!test && now.getTime() - delivery.createdAt.getTime() > DELIVERY_EXPIRY_MS) {
    await giveUp(DELIVERY_ERRORS.EXPIRED);
    return "expired";
  }
  if (!test && hook.status !== "ACTIVE") {
    await giveUp(DELIVERY_ERRORS.WEBHOOK_OFF);
    return "webhook_off";
  }

  const fail = async (lastError: string, statusCode: number | null): Promise<DeliveryOutcome> => {
    const attempts = delivery.attempts + 1;
    const exhausted = test || attempts >= MAX_ATTEMPTS;
    await settle(prisma, delivery.id, {
      attempts,
      status: exhausted ? "GIVEN_UP" : "FAILED",
      lastStatusCode: statusCode,
      lastError,
      nextAttemptAt: exhausted ? now : new Date(now.getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? 0)),
    });
    if (!test) await recordWebhookFailure(prisma, hook, deps);
    return exhausted ? "gave_up" : "retry";
  };

  // 2. the SSRF guard
  let dest: PinnedDestination;
  try {
    dest = await deps.resolveDestination(openWebhookUrl(hook.id, hook.urlEnc));
  } catch (err) {
    return fail(describeFailure(err), null);
  }

  // 3. the egress switch — off-LAN only; a LAN destination never asks
  if (dest.scope === "public" && !(await deps.gate())) {
    // Not a failure: nothing was attempted, so nothing is counted and the ladder
    // does not advance. A test has nobody to wait for, so it settles at once.
    await prisma.pmWebhookDelivery.updateMany({
      where: { id: delivery.id, status: { in: [...OWED] } },
      data: test
        ? { status: "GIVEN_UP", lastError: DELIVERY_ERRORS.EGRESS_BLOCKED, nextAttemptAt: now }
        : {
            lastError: DELIVERY_ERRORS.EGRESS_BLOCKED,
            nextAttemptAt: new Date(now.getTime() + BLOCKED_RECHECK_MS),
          },
    });
    return "blocked";
  }

  // 4. sign the exact bytes and send
  let secret: string;
  try {
    secret = openWebhookSecret(hook.id, hook.secretEnc);
  } catch {
    return fail(DELIVERY_ERRORS.SECRET_UNREADABLE, null);
  }
  const body = renderWebhookBody(hook.format, delivery.payload as unknown as WebhookPayloadV1);
  const headers = {
    "content-type": "application/json",
    "user-agent": "Droplet-Webhooks/1",
    [EVENT_HEADER.toLowerCase()]: delivery.event,
    [DELIVERY_HEADER.toLowerCase()]: delivery.id,
    [SIGNATURE_HEADER.toLowerCase()]: signWebhookBody(secret, body, Math.floor(now.getTime() / 1000)),
  };
  let status: number;
  try {
    ({ status } = await deps.send(dest, { headers, body }));
  } catch (err) {
    return fail(describeFailure(err), null);
  }
  if (status < 200 || status >= 300) return fail(`HTTP ${status}`, status);

  await settle(prisma, delivery.id, {
    status: "DELIVERED",
    attempts: delivery.attempts + 1,
    deliveredAt: now,
    lastStatusCode: status,
    lastError: null,
    nextAttemptAt: now,
  });
  if (!test) {
    await prisma.pmWebhook.updateMany({
      where: { id: hook.id, consecutiveFailures: { gt: 0 } },
      data: { consecutiveFailures: 0 },
    });
  }
  return "delivered";
}

export interface DeliverySweepResult {
  claimed: number;
  delivered: number;
  retried: number;
  gaveUp: number;
  blocked: number;
  expired: number;
  webhookOff: number;
  /** Rows whose attempt threw something unexpected (a database error). They keep
   *  their lease and come round again when it ends. */
  errored: number;
}

/** One sweep: claim what is due, attempt it a few at a time, tally. */
export async function runWebhookDeliveries(
  prisma: PrismaClient,
  deps: DeliveryDeps = {},
): Promise<DeliverySweepResult> {
  const d = resolveDeliveryDeps(prisma, deps);
  const claimed = await claimDueDeliveries(prisma, d.now());
  const tally: DeliverySweepResult = {
    claimed: claimed.length,
    delivered: 0,
    retried: 0,
    gaveUp: 0,
    blocked: 0,
    expired: 0,
    webhookOff: 0,
    errored: 0,
  };
  if (claimed.length === 0) return tally;

  // One read of the switch per sweep, however many deliveries need it.
  let gateRead: Promise<boolean> | null = null;
  const gate = (): Promise<boolean> => (gateRead ??= d.gate());
  const deps2: ResolvedDeps = { ...d, gate };

  for (let i = 0; i < claimed.length; i += DELIVERY_CONCURRENCY) {
    const chunk = claimed.slice(i, i + DELIVERY_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async (delivery): Promise<DeliveryOutcome | "errored"> => {
        try {
          return await attemptDelivery(prisma, delivery, {}, deps2);
        } catch (err) {
          d.logger.error({ err, deliveryId: delivery.id }, "pm-webhook: delivery attempt threw");
          return "errored";
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome === "delivered") tally.delivered += 1;
      else if (outcome === "retry") tally.retried += 1;
      else if (outcome === "gave_up") tally.gaveUp += 1;
      else if (outcome === "blocked") tally.blocked += 1;
      else if (outcome === "expired") tally.expired += 1;
      else if (outcome === "webhook_off") tally.webhookOff += 1;
      else tally.errored += 1;
    }
  }
  return tally;
}

/** Drop finished rows past the retention window. Returns how many went. */
export async function pruneWebhookDeliveries(
  prisma: Pick<PrismaClient, "pmWebhookDelivery">,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.pmWebhookDelivery.deleteMany({
    where: {
      status: { in: ["DELIVERED", "GIVEN_UP"] },
      createdAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) },
    },
  });
  return count;
}
