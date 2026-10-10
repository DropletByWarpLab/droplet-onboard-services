/**
 * WARP-3904 — fixtures for the connect-from-chat tool tests.
 *
 * The orchestrator's `/api/connections` routes are built in parallel by
 * another change, so these mirror the contract in
 * `packages/shared-types/src/chat-connect.ts` rather than any live route.
 * Every value is a placeholder; nothing here is a real key.
 */
import { orchestratorCtx } from "./orchestrator-ctx.js";
import type { Role } from "../../src/types.js";

/** A context with a role and an acting person, over the recording orchestrator mocks. */
export function connectCtx(role: Role | null = "owner", userId: string | null = "person-1") {
  const made = orchestratorCtx(userId);
  // `null` is "no role at all": a default parameter would turn `undefined` into "owner".
  if (role !== null) made.ctx.role = role;
  return made;
}

export const ACTING_HEADERS = { headers: { Accept: "application/json", "X-Droplet-User": "person-1" } };

export const stripeRow = {
  id: "integration:stripe",
  family: "integration",
  provider: "stripe",
  displayName: "Stripe",
  detail: "Warp Lab",
  scope: "box",
  status: "connected",
  capabilities: ["payouts", "charges"],
  lastSyncAt: "2026-10-08T09:00:00.000Z",
  manageHref: "/connectors/stripe",
  canDisconnect: true,
  canReconnect: false,
} as const;

export const mailRow = {
  id: "mailbox:ckx1abc",
  family: "mailbox",
  provider: "mailbox",
  displayName: "Front desk",
  detail: "frontdesk@example.test",
  scope: "personal",
  status: "needs_attention",
  statusDetail: "The password was rejected. Sign in again to fix it.",
  capabilities: ["mail"],
  manageHref: "/email",
  canDisconnect: true,
  canReconnect: false,
} as const;

export const hubspotAvailable = {
  provider: "hubspot",
  family: "integration",
  displayName: "HubSpot",
  category: "CRM",
  scope: "box",
  canConnect: true,
} as const;

export function overviewOf(
  connected: unknown[],
  available: unknown[] = [hubspotAvailable],
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "connections_overview",
    connected,
    available,
    counts: { connected: connected.length, needsAttention: 0, available: available.length },
    boxWideVisible: true,
    ...extra,
  };
}

/** A credentials card whose one secret field arrives empty, as a real one does. */
export const stripeCard = {
  kind: "connect_card",
  provider: "stripe",
  family: "integration",
  displayName: "Stripe",
  category: "Payments",
  scope: "box",
  summary: "Reads payouts, charges, customers · polled every 15 min",
  safety: "setup-internet",
  helpHref: "/help/connectors/stripe",
  manageHref: "/connectors/stripe",
  mode: "credentials",
  fields: [
    {
      name: "apiKey",
      label: "Restricted API key",
      type: "password",
      required: true,
      secret: true,
      placeholder: "Paste the key",
      help: "Create a restricted key with read access in the Stripe dashboard.",
    },
  ],
  post: { path: "/api/connectors/stripe/connect" },
} as const;

export const googleCard = {
  kind: "connect_card",
  provider: "google",
  family: "google",
  displayName: "Google",
  scope: "personal",
  summary: "Reads mail, calendar and files you tick · you sign in with Google",
  safety: "setup-internet",
  manageHref: "/settings#connected-accounts",
  mode: "oauth",
  providerLabel: "Google",
  options: [
    { name: "mail", label: "Mail", defaultChecked: true },
    { name: "calendar", label: "Calendar", help: "Events and invitations.", defaultChecked: true },
  ],
  start: { path: "/api/google/connect" },
} as const;

export const blockedCard = {
  kind: "connect_card",
  provider: "stripe",
  family: "integration",
  displayName: "Stripe",
  scope: "box",
  summary: "Reads payouts, charges, customers · polled every 15 min",
  safety: "setup-internet",
  manageHref: "/connectors/stripe",
  mode: "credentials",
  fields: [],
  post: { path: "/api/connectors/stripe/connect" },
  blocked: {
    reason: "role",
    message: "Stripe is shared by the whole box, so an owner or admin has to connect it.",
    requiredRole: "admin",
  },
} as const;

export const disconnectedOk = {
  kind: "connection_disconnected",
  provider: "mailchimp",
  family: "integration",
  displayName: "Mailchimp",
} as const;
