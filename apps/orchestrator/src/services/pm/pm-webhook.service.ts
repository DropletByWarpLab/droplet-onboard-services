/**
 * Work webhooks — the management layer behind `/api/pm/webhooks`
 * (WARP-3532, ADR-069 §9). Create, edit, pause, rotate, delete, test, re-deliver
 * and read the delivery log. Delivery itself is webhook-delivery.service.ts.
 *
 * Errors are `Error(code)` with the stable codes in `PM_WEBHOOK_ERRORS`, which
 * the route maps to HTTP — the convention pm.service.ts established.
 *
 * What a read never returns: the signing secret, and the URL's path. A chat app's
 * incoming-webhook URL IS its credential (anyone holding it can post as the
 * integration), so the owner is shown the destination — scheme, host, port — and
 * the path is write-only, like the secret. Changing the address means pasting it
 * again; every other edit leaves it alone.
 */
import { randomUUID } from "node:crypto";
import type {
  PmWebhook,
  PmWebhookDelivery,
  PmWebhookFormat,
  PmWebhookStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { assertLanOrPublicUrl, isOutboundUrlBlocked } from "../../lib/outbound-url-guard.js";
import { ensureHomeWorkspace } from "./pm.service.js";
import {
  attemptDelivery,
  resolveDeliveryDeps,
  type DeliveryDeps,
  type DeliveryWithWebhook,
} from "./webhook-delivery.service.js";
import { WEBHOOK_TEST_EVENT, isSubscribableEvent } from "./webhook-events.js";
import { buildTestPayload } from "./webhook-payload.js";
import { sealWebhookSecret } from "./webhook-secret.js";
import { generateWebhookSecret } from "./webhook-signature.js";

export const PM_WEBHOOK_ERRORS = {
  NOT_FOUND: "webhook_not_found",
  DELIVERY_NOT_FOUND: "delivery_not_found",
  PROJECT_NOT_FOUND: "project_not_found",
  /** The address is one a webhook may never use. Carries no detail by design. */
  BLOCKED_DESTINATION: "blocked_destination",
  INVALID_EVENTS: "invalid_events",
  LIMIT_REACHED: "webhook_limit_reached",
} as const;

/** Webhooks per workspace. Each event fans out to every matching one. */
export const PM_WEBHOOK_LIMIT = 50;

export const DELIVERY_LIST_DEFAULT = 50;
export const DELIVERY_LIST_MAX = 200;

type WebhookPrisma = PrismaClient;

export interface ApiWebhook {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  /** Scheme, host and port only — never the path. */
  destination: string;
  format: PmWebhookFormat;
  events: string[];
  enabled: boolean;
  status: PmWebhookStatus;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  lastDelivery: { status: string; at: string; statusCode: number | null } | null;
}

export interface ApiDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** `ENG-12 · Fix the login bug`, or null for a test message. */
  subject: string | null;
}

/** Scheme, host and port of a webhook URL (no path, no query) — the part that is not a secret. */
export function destinationOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function toApi(row: PmWebhook, lastDelivery: ApiWebhook["lastDelivery"] = null): ApiWebhook {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    destination: destinationOf(row.url),
    format: row.format,
    events: row.events,
    enabled: row.enabled,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastDelivery,
  };
}

function subjectOf(payload: Prisma.JsonValue): string | null {
  const item = (payload as { workItem?: { key?: unknown; name?: unknown } | null } | null)?.workItem;
  if (!item || typeof item.key !== "string") return null;
  const name = typeof item.name === "string" ? item.name : "";
  const flat = name.replace(/\s+/g, " ").trim();
  return flat ? `${item.key} · ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}` : item.key;
}

export function toApiDelivery(row: PmWebhookDelivery): ApiDelivery {
  return {
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    subject: subjectOf(row.payload),
  };
}

/** The URL, vetted. The guard's refusal becomes this module's one code for it,
 *  with the detail left behind — the response must not say WHICH rule fired. */
function vetUrl(raw: string): string {
  try {
    return assertLanOrPublicUrl(raw).toString();
  } catch (err) {
    if (isOutboundUrlBlocked(err)) throw new Error(PM_WEBHOOK_ERRORS.BLOCKED_DESTINATION);
    throw err;
  }
}

function vetEvents(events: readonly string[]): string[] {
  const unique = [...new Set(events)];
  if (unique.length === 0 || !unique.every(isSubscribableEvent)) {
    throw new Error(PM_WEBHOOK_ERRORS.INVALID_EVENTS);
  }
  return unique;
}

async function mustFind(prisma: WebhookPrisma, id: string): Promise<PmWebhook> {
  const row = await prisma.pmWebhook.findUnique({ where: { id } });
  if (!row) throw new Error(PM_WEBHOOK_ERRORS.NOT_FOUND);
  return row;
}

/** The project must exist; its workspace becomes the webhook's. */
async function workspaceForProject(prisma: WebhookPrisma, projectId: string): Promise<string> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) throw new Error(PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND);
  return project.workspaceId;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listWebhooks(prisma: WebhookPrisma): Promise<ApiWebhook[]> {
  const rows = await prisma.pmWebhook.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (rows.length === 0) return [];
  // One query for every webhook's latest delivery, not one each.
  const latest = await prisma.$queryRaw<
    Array<{ webhookId: string; status: string; createdAt: Date; lastStatusCode: number | null }>
  >`
    SELECT DISTINCT ON ("webhookId") "webhookId", "status"::text AS "status", "createdAt", "lastStatusCode"
    FROM "PmWebhookDelivery"
    WHERE "webhookId" = ANY(${rows.map((r) => r.id)}::text[])
    ORDER BY "webhookId", "createdAt" DESC
  `;
  const byHook = new Map(latest.map((d) => [d.webhookId, d]));
  return rows.map((row) => {
    const d = byHook.get(row.id);
    return toApi(row, d ? { status: d.status, at: d.createdAt.toISOString(), statusCode: d.lastStatusCode } : null);
  });
}

export async function getWebhook(prisma: WebhookPrisma, id: string): Promise<ApiWebhook> {
  return toApi(await mustFind(prisma, id));
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface WebhookInput {
  name: string;
  url: string;
  format: PmWebhookFormat;
  events: string[];
  projectId?: string | null;
}

/** Create a webhook and mint its secret. The plaintext is returned ONCE. */
export async function createWebhook(
  prisma: WebhookPrisma,
  actorId: string | null,
  input: WebhookInput,
): Promise<{ webhook: ApiWebhook; secret: string }> {
  const url = vetUrl(input.url);
  const events = vetEvents(input.events);
  const workspaceId = input.projectId
    ? await workspaceForProject(prisma, input.projectId)
    : (await ensureHomeWorkspace(prisma)).id;
  if ((await prisma.pmWebhook.count({ where: { workspaceId } })) >= PM_WEBHOOK_LIMIT) {
    throw new Error(PM_WEBHOOK_ERRORS.LIMIT_REACHED);
  }

  const id = randomUUID();
  const secret = generateWebhookSecret();
  const row = await prisma.pmWebhook.create({
    data: {
      id,
      workspaceId,
      projectId: input.projectId ?? null,
      name: input.name,
      url,
      format: input.format,
      events,
      secretEnc: sealWebhookSecret(id, secret),
      createdById: actorId,
    },
  });
  return { webhook: toApi(row), secret };
}

export interface WebhookPatch {
  name?: string;
  url?: string;
  format?: PmWebhookFormat;
  events?: string[];
  /** `null` widens it back to the whole workspace. */
  projectId?: string | null;
  /** `true` resumes (and forgives the failure count); `false` pauses. */
  enabled?: boolean;
}

export async function updateWebhook(
  prisma: WebhookPrisma,
  id: string,
  patch: WebhookPatch,
): Promise<ApiWebhook> {
  const existing = await mustFind(prisma, id);
  const data: Prisma.PmWebhookUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.url !== undefined) data.url = vetUrl(patch.url);
  if (patch.format !== undefined) data.format = patch.format;
  if (patch.events !== undefined) data.events = vetEvents(patch.events);
  if (patch.projectId !== undefined) {
    if (patch.projectId === null) {
      data.project = { disconnect: true };
    } else {
      // A webhook stays inside its own workspace: re-scoping to another
      // workspace's project would be moving it, which is not an edit.
      const workspaceId = await workspaceForProject(prisma, patch.projectId);
      if (workspaceId !== existing.workspaceId) throw new Error(PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND);
      data.project = { connect: { id: patch.projectId } };
    }
  }
  if (patch.enabled === true) {
    // `enabled` and `status` move together — the table holds `enabled ⇔ ACTIVE`.
    data.enabled = true;
    data.status = "ACTIVE";
    data.consecutiveFailures = 0;
  } else if (patch.enabled === false) {
    data.enabled = false;
    data.status = "PAUSED";
  }
  const row = await prisma.pmWebhook.update({ where: { id }, data });
  return toApi(row);
}

export async function deleteWebhook(prisma: WebhookPrisma, id: string): Promise<ApiWebhook> {
  const existing = await mustFind(prisma, id);
  // Its deliveries go with it (ON DELETE CASCADE): a delivery log with no
  // webhook to attribute it to is noise, and a queued one must not outlive the
  // owner's decision to stop sending.
  await prisma.pmWebhook.delete({ where: { id } });
  return toApi(existing);
}

/** Replace the signing secret. Effective at once, for queued retries too. */
export async function rotateWebhookSecret(
  prisma: WebhookPrisma,
  id: string,
): Promise<{ webhook: ApiWebhook; secret: string }> {
  await mustFind(prisma, id);
  const secret = generateWebhookSecret();
  const row = await prisma.pmWebhook.update({
    where: { id },
    data: { secretEnc: sealWebhookSecret(id, secret) },
  });
  return { webhook: toApi(row), secret };
}

// ── Delivery log, test, re-deliver ───────────────────────────────────────────

export async function listDeliveries(
  prisma: WebhookPrisma,
  webhookId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ deliveries: ApiDelivery[]; nextCursor: string | null }> {
  await mustFind(prisma, webhookId);
  const limit = Math.min(Math.max(opts.limit ?? DELIVERY_LIST_DEFAULT, 1), DELIVERY_LIST_MAX);
  const cursor = parseCursor(opts.cursor);
  const rows = await prisma.pmWebhookDelivery.findMany({
    where: {
      webhookId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.at } },
              { createdAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    deliveries: page.map(toApiDelivery),
    nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const [iso, id] = raw.split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime())) return null;
  return { at, id };
}

/**
 * Send one test message NOW and report what happened. The row goes through the
 * same `attemptDelivery` as every real one — the guard, the egress switch, the
 * signature — so a green test means a real event would arrive, and a red one says
 * why. One attempt: a failed test is GIVEN_UP, never queued for retry.
 */
export async function sendTestDelivery(
  prisma: WebhookPrisma,
  id: string,
  actor: { id: string | null; name: string | null },
  deps: DeliveryDeps = {},
): Promise<ApiDelivery> {
  const hook = await mustFind(prisma, id);
  const workspace = await prisma.pmWorkspace.findUnique({ where: { id: hook.workspaceId } });
  if (!workspace) throw new Error(PM_WEBHOOK_ERRORS.NOT_FOUND);
  const d = resolveDeliveryDeps(prisma, deps);
  const now = d.now();
  const payload = buildTestPayload({
    eventId: randomUUID(),
    event: WEBHOOK_TEST_EVENT,
    occurredAt: now,
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    actor,
  });
  const created = await prisma.pmWebhookDelivery.create({
    data: {
      webhookId: hook.id,
      event: WEBHOOK_TEST_EVENT,
      payload: payload as unknown as Prisma.InputJsonValue,
      nextAttemptAt: now,
    },
  });
  const delivery: DeliveryWithWebhook = { ...created, webhook: hook };
  await attemptDelivery(prisma, delivery, { test: true }, d);
  const settled = await prisma.pmWebhookDelivery.findUniqueOrThrow({ where: { id: created.id } });
  return toApiDelivery(settled);
}

/**
 * Queue the same event again as a NEW delivery. The original row stays in the log
 * as it was, so the history shows both; the payload — and therefore its `id` —
 * is identical, which is what lets a receiver that did get the first one
 * recognise the second.
 */
export async function redeliver(
  prisma: WebhookPrisma,
  webhookId: string,
  deliveryId: string,
): Promise<ApiDelivery> {
  await mustFind(prisma, webhookId);
  const original = await prisma.pmWebhookDelivery.findFirst({ where: { id: deliveryId, webhookId } });
  if (!original) throw new Error(PM_WEBHOOK_ERRORS.DELIVERY_NOT_FOUND);
  const row = await prisma.pmWebhookDelivery.create({
    data: {
      webhookId,
      event: original.event,
      payload: original.payload as Prisma.InputJsonValue,
      nextAttemptAt: new Date(),
    },
  });
  return toApiDelivery(row);
}
