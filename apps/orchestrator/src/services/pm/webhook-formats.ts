/**
 * Chat-app renderings of a work event (WARP-3532).
 *
 * `JSON` is the payload v1 verbatim. The other four turn the SAME stored payload
 * into the incoming-webhook body that app expects, at send time — so a webhook
 * switched from Slack to Teams re-renders its queued deliveries correctly, and
 * the payload on the delivery row never depends on who receives it.
 *
 * The text that reaches a chat app is the one place this feature puts words an
 * employee typed (a work item's title, a person's name) into somebody else's
 * markup, so it is treated as hostile on every path:
 *
 *   - Slack: `&`, `<`, `>` are entity-escaped, which is Slack's own rule and is
 *     what stops a title of `<!channel>` from paging the whole workspace.
 *   - Discord: `allowed_mentions: { parse: [] }` — the message can name anybody
 *     and ping nobody, whatever the title says.
 *   - Google Chat: `<users/all>` is its mention syntax and it has no escape, so
 *     `<` and `>` are broken with a zero-width space and no longer parse.
 *   - Teams: an Adaptive Card mentions nobody without `msteams.entities`, which
 *     this never sets; markdown control characters are backslash-escaped.
 *   - Everywhere: control characters and newlines collapse to a space and the
 *     text is truncated, so a title cannot forge a second line or a wall of text.
 *
 * No URL is written here as a literal. The deep link comes from the payload; the
 * Teams card omits `$schema`, which is optional, rather than carry a vendor
 * address the egress registry would then have to explain.
 */
import type { PmWebhookFormat } from "@prisma/client";
import { WEBHOOK_TEST_EVENT } from "./webhook-events.js";
import type { WebhookChange, WebhookPayloadV1 } from "./webhook-payload.js";

const NAME_MAX = 120;
const LABEL_MAX = 60;
const DETAIL_MAX = 300;
const ZWSP = "\u200b";

/** Collapse control characters and whitespace runs to one space; truncate. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const FIELD_LABELS: Record<string, string> = {
  state: "State",
  priority: "Priority",
  dueDate: "Due date",
  assignees: "Assignee",
  department: "Department",
  parentId: "Parent",
  relation: "Relation",
};

function changeLine(change: WebhookChange): string {
  const label = FIELD_LABELS[change.field] ?? change.field;
  const from = change.fromLabel ?? change.from ?? "none";
  const to = change.toLabel ?? change.to ?? "none";
  return `${label}: ${cleanText(from, LABEL_MAX)} → ${cleanText(to, LABEL_MAX)}`;
}

/** The sentence, in plain parts each renderer marks up for its own app. */
export interface Described {
  /** `Ana`, or `Droplet` when nobody did it. */
  actor: string;
  /** What was done, up to the work item: `moved`, `commented on`, `assigned Ben to`. */
  lead: string;
  /** `ENG-12 Fix the login bug`, or null for a test message. */
  subject: string | null;
  /** What follows the subject: ` to In progress`. */
  tail: string;
  /** A second line, or null. */
  detail: string | null;
  url: string | null;
}

export function describeEvent(payload: WebhookPayloadV1): Described {
  const actor = payload.actor.name ? cleanText(payload.actor.name, LABEL_MAX) : "Droplet";
  const item = payload.workItem;
  if (payload.event === WEBHOOK_TEST_EVENT || !item) {
    return {
      actor,
      lead: "sent a test message: Work notifications is connected",
      subject: null,
      tail: "",
      detail: null,
      url: null,
    };
  }
  const subject = `${item.key} ${cleanText(item.name, NAME_MAX)}`;
  const first = payload.changes[0];
  let lead = "updated";
  let tail = "";
  let detail: string | null = null;
  switch (payload.event) {
    case "work_item.created":
      lead = "created";
      break;
    case "work_item.state_changed": {
      lead = "moved";
      const to = first?.toLabel ?? item.state?.name;
      tail = to ? ` to ${cleanText(to, LABEL_MAX)}` : "";
      break;
    }
    case "work_item.assigned": {
      const who = first?.toLabel ?? "someone";
      lead = `assigned ${cleanText(who, LABEL_MAX)} to`;
      break;
    }
    case "work_item.commented":
      lead = "commented on";
      break;
    case "work_item.archived":
      lead = "archived";
      break;
    default:
      lead = "updated";
      if (payload.changes.length > 0) {
        detail = cleanText(payload.changes.map(changeLine).join("; "), DETAIL_MAX);
      }
  }
  return { actor, lead, subject, tail, detail, url: item.url };
}

// ── Slack (also what Mattermost-style receivers accept) ─────────────────────

const slackEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slack(d: Described): unknown {
  const subject = d.subject
    ? d.url
      ? `<${d.url}|${slackEscape(d.subject)}>`
      : slackEscape(d.subject)
    : "";
  const line = `*${slackEscape(d.actor)}* ${slackEscape(d.lead)}${subject ? ` ${subject}` : ""}${slackEscape(d.tail)}`;
  return {
    text: d.detail ? `${line}\n${slackEscape(d.detail)}` : line,
    unfurl_links: false,
    unfurl_media: false,
  };
}

// ── Discord ──────────────────────────────────────────────────────────────────

const markdownEscape = (s: string): string => s.replace(/([\\*_`~|[\]<>#>])/g, "\\$1");

function discord(d: Described): unknown {
  const subject = d.subject
    ? d.url
      ? `[${markdownEscape(d.subject)}](<${d.url}>)`
      : markdownEscape(d.subject)
    : "";
  const line = `**${markdownEscape(d.actor)}** ${markdownEscape(d.lead)}${subject ? ` ${subject}` : ""}${markdownEscape(d.tail)}`;
  const content = d.detail ? `${line}\n${markdownEscape(d.detail)}` : line;
  return {
    username: "Droplet",
    // Whatever the text says, nobody is pinged.
    allowed_mentions: { parse: [] },
    content: content.length > 1900 ? `${content.slice(0, 1899)}…` : content,
  };
}

// ── Google Chat ──────────────────────────────────────────────────────────────

/** Chat has no escape for `<`; breaking the sequence is what stops `<users/all>`. */
const chatBreak = (s: string): string => s.replace(/</g, `<${ZWSP}`).replace(/>/g, `${ZWSP}>`);

function googleChat(d: Described): unknown {
  const subject = d.subject
    ? d.url
      ? `<${d.url}|${chatBreak(d.subject).replace(/\|/g, "¦")}>`
      : chatBreak(d.subject)
    : "";
  const line = `*${chatBreak(d.actor)}* ${chatBreak(d.lead)}${subject ? ` ${subject}` : ""}${chatBreak(d.tail)}`;
  return { text: d.detail ? `${line}\n${chatBreak(d.detail)}` : line };
}

// ── Microsoft Teams (Workflows: an Adaptive Card in a message envelope) ─────

function teams(d: Described): unknown {
  const subject = d.subject
    ? d.url
      ? `[${markdownEscape(d.subject)}](${d.url})`
      : markdownEscape(d.subject)
    : "";
  const line = `**${markdownEscape(d.actor)}** ${markdownEscape(d.lead)}${subject ? ` ${subject}` : ""}${markdownEscape(d.tail)}`;
  const body: unknown[] = [{ type: "TextBlock", text: line, wrap: true }];
  if (d.detail) body.push({ type: "TextBlock", text: markdownEscape(d.detail), wrap: true, isSubtle: true });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: { type: "AdaptiveCard", version: "1.4", body },
      },
    ],
  };
}

/** The exact bytes to send (and to sign) for `payload` in `format`. */
export function renderWebhookBody(format: PmWebhookFormat, payload: WebhookPayloadV1): string {
  if (format === "JSON") return JSON.stringify(payload);
  const described = describeEvent(payload);
  switch (format) {
    case "SLACK":
      return JSON.stringify(slack(described));
    case "DISCORD":
      return JSON.stringify(discord(described));
    case "GOOGLE_CHAT":
      return JSON.stringify(googleChat(described));
    case "TEAMS":
      return JSON.stringify(teams(described));
  }
}
