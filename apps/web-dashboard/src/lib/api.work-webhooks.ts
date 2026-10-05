/**
 * Typed client for Settings → Integrations → Work notifications (WARP-3532):
 * the orchestrator's `/api/pm/webhooks` routes. Owner and admin only on the
 * server; the page hides what a role cannot do and the box refuses it anyway.
 *
 * Two things this client deliberately never does:
 *   - hold a webhook's address after the form that typed it is gone. The server
 *     returns the destination (scheme, host, port) and never the path, because
 *     a chat app's webhook URL is its credential;
 *   - keep a signing secret. `createWorkWebhook` and `rotateWorkWebhookSecret`
 *     return one, once, and the caller shows it and lets it go.
 */
import { authFetch } from "./auth";

const BASE = "";

export type WorkWebhookFormat = "JSON" | "SLACK" | "TEAMS" | "DISCORD" | "GOOGLE_CHAT";
export type WorkWebhookStatus = "ACTIVE" | "PAUSED" | "DISABLED_FAILING";
export type WorkDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED" | "GIVEN_UP";

export interface WorkWebhook {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  /** Scheme, host and port. Never the path. */
  destination: string;
  format: WorkWebhookFormat;
  events: string[];
  enabled: boolean;
  status: WorkWebhookStatus;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  lastDelivery: { status: string; at: string; statusCode: number | null } | null;
}

export interface WorkEventInfo {
  name: string;
  label: string;
  description: string;
}

export interface WorkWebhookDelivery {
  id: string;
  event: string;
  status: WorkDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  subject: string | null;
}

export interface WorkWebhookInput {
  name: string;
  url: string;
  format: WorkWebhookFormat;
  events: string[];
  projectId: string | null;
}

export type WorkWebhookPatch = Partial<WorkWebhookInput> & { enabled?: boolean };

/** A failed call. `message` is the box's own sentence when it sent one, which it
 *  does for every refusal a person can act on (a blocked address, no events). */
export class WorkWebhookError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "WorkWebhookError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
    throw new WorkWebhookError(
      typeof body.message === "string" && body.message
        ? body.message
        : `That didn’t work (${res.status}). Try again in a moment.`,
      res.status,
      typeof body.error === "string" ? body.error : null,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function fetchWorkWebhooks(): Promise<{ webhooks: WorkWebhook[]; events: WorkEventInfo[] }> {
  return call("/api/pm/webhooks");
}

export function createWorkWebhook(input: WorkWebhookInput): Promise<{ webhook: WorkWebhook; secret: string }> {
  return call("/api/pm/webhooks", { method: "POST", body: JSON.stringify(input) });
}

export function updateWorkWebhook(id: string, patch: WorkWebhookPatch): Promise<{ webhook: WorkWebhook }> {
  return call(`/api/pm/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkWebhook(id: string): Promise<void> {
  return call(`/api/pm/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function rotateWorkWebhookSecret(id: string): Promise<{ webhook: WorkWebhook; secret: string }> {
  return call(`/api/pm/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: "POST", body: "{}" });
}

export function testWorkWebhook(id: string): Promise<{ delivery: WorkWebhookDelivery }> {
  return call(`/api/pm/webhooks/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
}

export function fetchWorkWebhookDeliveries(
  id: string,
  cursor?: string | null,
): Promise<{ deliveries: WorkWebhookDelivery[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: "25" });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/pm/webhooks/${encodeURIComponent(id)}/deliveries?${q.toString()}`);
}

export function redeliverWorkWebhook(id: string, deliveryId: string): Promise<{ delivery: WorkWebhookDelivery }> {
  return call(
    `/api/pm/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
    { method: "POST", body: "{}" },
  );
}

/** The projects a webhook can be narrowed to. */
export async function fetchWebhookScopeProjects(): Promise<Array<{ id: string; name: string; identifier: string }>> {
  const body = await call<{ projects?: Array<{ id: string; name: string; identifier: string }> }>("/api/pm/projects");
  return (body.projects ?? []).map((p) => ({ id: p.id, name: p.name, identifier: p.identifier }));
}
