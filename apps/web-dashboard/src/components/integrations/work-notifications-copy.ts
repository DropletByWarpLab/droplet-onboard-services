/**
 * Words for Settings → Integrations → Work notifications (WARP-3532).
 *
 * Plain language, no exclamation marks (projects brief §6). No chat app's
 * address is written here: the box decides what a destination is when it sends,
 * not the page, and a hostname literal in dashboard source is a destination the
 * egress registry would have to explain.
 */
import type { WorkDeliveryStatus, WorkWebhookFormat, WorkWebhookStatus } from "@/lib/api.work-webhooks";

export const FORMAT_OPTIONS: ReadonlyArray<{
  value: WorkWebhookFormat;
  label: string;
  defaultName: string;
  help: string;
}> = [
  {
    value: "SLACK",
    label: "Slack",
    defaultName: "Slack",
    help: "In Slack, add an Incoming Webhook to the channel you want and paste its address here.",
  },
  {
    value: "TEAMS",
    label: "Microsoft Teams",
    defaultName: "Teams",
    help: "In Teams, add a Workflows webhook to a channel (“Post to a channel when a webhook request is received”) and paste its address here.",
  },
  {
    value: "DISCORD",
    label: "Discord",
    defaultName: "Discord",
    help: "In Discord, open the channel’s Integrations settings, create a webhook and paste its address here.",
  },
  {
    value: "GOOGLE_CHAT",
    label: "Google Chat",
    defaultName: "Google Chat",
    help: "In Google Chat, add a webhook to the space and paste its address here.",
  },
  {
    value: "JSON",
    label: "Other (JSON)",
    defaultName: "Webhook",
    help: "Droplet sends a signed JSON message to any address, such as a local n8n or Home Assistant on your network.",
  },
];

export const WEBHOOK_STATUS_COPY: Record<
  WorkWebhookStatus,
  { label: string; kind: "ok" | "muted" | "danger" }
> = {
  ACTIVE: { label: "Active", kind: "ok" },
  PAUSED: { label: "Paused", kind: "muted" },
  DISABLED_FAILING: { label: "Turned off after repeated failures", kind: "danger" },
};

export const DELIVERY_STATUS_COPY: Record<
  WorkDeliveryStatus,
  { label: string; kind: "ok" | "muted" | "warn" | "danger" }
> = {
  DELIVERED: { label: "Delivered", kind: "ok" },
  PENDING: { label: "Waiting", kind: "muted" },
  FAILED: { label: "Retrying", kind: "warn" },
  GIVEN_UP: { label: "Gave up", kind: "danger" },
};

/** What the box writes to `lastError` when the egress switch holds a delivery. */
export const EGRESS_BLOCKED_ERROR = "Blocked by egress setting";

export const EGRESS_BLOCKED_HINT =
  "Turn on “Send work updates outside your network” at the top of this page, then try again.";

export const EMPTY_STATE =
  "No webhooks yet. Add one to post work updates to Slack, Teams, Discord or Google Chat, or to send them to any address that can receive a webhook.";

/** The one line that must stay on the page next to the secret. */
export const SECRET_ONCE_NOTE =
  "This is the only time Droplet shows this secret. Copy it now and keep it in your receiver’s settings. If you lose it, rotate it to get a new one.";
