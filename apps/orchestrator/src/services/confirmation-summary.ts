/**
 * WARP-2469 — the PHI-free argument summary shown in the chat approval
 * prompt.
 *
 * THE PROBLEM. WARP-2305 made `requiresConfirmation` a real gate: a
 * confirming tool is refused until a bound token is presented. WARP-2469
 * gives the user a way to mint that token — which means, for the first
 * time, rendering a tool call to a human INSIDE chat and asking them to
 * approve it. A prompt that says only "email_send needs approval" is not
 * an approval, it is a dialog box; a prompt that dumps the arguments
 * puts customer content — and on the ERP/health surfaces, PHI — into the
 * chat transcript, the SSE stream, and every persisted `ChatMessage`
 * row.
 *
 * THE POSTURE, and it is the same one `confirmation-audit.ts` takes for
 * the audit scope: PHI-freedom is a property of the SHAPE, not of a
 * redaction pass that has to be right about every value. This module
 * emits a closed set of fields the orchestrator itself computed — an
 * argument's KEY, its KIND, and its SIZE — and there is no field an
 * argument value could be placed in. `lib/log-redaction.ts` still runs
 * first, as the backstop it is (rule 19), so a value that IS a secret is
 * replaced before its length is ever measured.
 *
 * The one exception is `boolean`, which is rendered verbatim. A boolean
 * has exactly two values and carries no information beyond the key that
 * names it, so `force: true` is safe and is precisely the kind of detail
 * that makes an approval meaningful.
 *
 * WARP-3569 — WHAT THE PERSON MAY SEE. Shape alone is not informed
 * consent: "to: 1 item" does not tell a member who is about to receive
 * their message, and "path: 24 characters" does not say which file is
 * about to be deleted. So a closed per-tool allowlist
 * ({@link APPROVAL_SHOWN_ARGUMENTS}) names the arguments that DECIDE the
 * action (recipient, path, share target, network or device target) and
 * those are returned in `shown`. Everything else stays shape-only: bodies,
 * subjects, descriptions, record contents and credentials are never in
 * `shown`. Each shown value is secret-scrubbed first, stripped of control
 * and bidi characters, and length-capped, so it cannot forge extra lines
 * in the prompt or flood it.
 *
 * `shown` goes to the browser of the approving user only (the SSE
 * challenge and the parked-run read). It is never given to the model, and
 * never to the audit chain: `confirmation-audit.ts` builds its rows from
 * tool name and outcome and has no field an argument could be put in. The
 * parked-run notification is built from `fields` (key and size) and does
 * not use `shown`.
 *
 * A confirming tool must have an allowlist entry or an explicit
 * {@link APPROVAL_NO_SAFE_VALUE} waiver naming why: the guard test
 * `confirmation-approval-values.guard.test.ts` fails otherwise, so a new
 * confirming tool cannot ship with a blind prompt by default.
 */
import { redactSecretParams } from "../lib/log-redaction.js";

/**
 * Argument keys that are protocol, not payload, and are therefore left
 * out of the summary entirely.
 *
 * Mirrors `CONFIRMATION_CONTROL_KEYS` in
 * `@droplet/tools-core/confirmation-token`: the interceptor excludes
 * `confirmed` from its binding hash, so showing it in the prompt would
 * describe a field that has no bearing on what is being approved.
 */
export const CONFIRMATION_SUMMARY_CONTROL_KEYS: readonly string[] = ["confirmed"];

/** How many argument fields a prompt will render before it stops. */
export const MAX_SUMMARY_FIELDS = 24;

export type SummaryFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface ConfirmationSummaryField {
  /** The argument's key, verbatim. Keys are schema-authored, not user data. */
  key: string;
  kind: SummaryFieldKind;
  /** Human-readable size/shape. NEVER the value. */
  detail: string;
  /**
   * Present ONLY for `kind === "boolean"`. Two possible values, no
   * information beyond the key — see the header.
   */
  value?: boolean;
}

export interface ConfirmationSummary {
  tool: string;
  fields: ConfirmationSummaryField[];
  /** Fields omitted by {@link MAX_SUMMARY_FIELDS}. Zero in the normal case. */
  truncatedFields: number;
  /**
   * WARP-3569 — the decisive values of the call, from
   * {@link APPROVAL_SHOWN_ARGUMENTS} only. Display text, never parsed.
   */
  shown: ConfirmationShownValue[];
}

export interface ConfirmationShownValue {
  /** The argument's key, verbatim. */
  key: string;
  /** Sanitised, capped display text. Never trusted as markup. */
  text: string;
}

/**
 * Per confirming tool, the arguments a person must see to approve it. Keep
 * to the value that decides WHO, WHERE or WHICH: never a message body, a
 * subject, a description, a free-text record field or a credential.
 *
 * Every confirming tool in the registry appears here or in
 * {@link APPROVAL_NO_SAFE_VALUE}.
 */
export const APPROVAL_SHOWN_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  // Files
  delete_file: ["path"],
  delete_files: ["paths"],
  restore_file_version: ["path", "version"],
  organize_files: ["path", "rule"],
  share_file: ["path", "expires_days", "allow_edit"],
  // Messages: who receives it, or which conversation. Not the text.
  team_chat_send_message: ["recipients", "thread_id"],
  team_chat_send_meeting_invite: ["recipients", "starts_at", "duration_minutes"],
  // Background runs: the task the person just asked for in this chat.
  start_agent_run: ["title", "deliverable"],
  // Cameras
  share_clip: ["nc_path", "ttl_minutes"],
  delete_clip: ["event_id"],
  set_camera_detection: ["camera", "enabled"],
  set_detection_zones: ["camera"],
  // Network and switch
  block_network_device: ["mac", "name"],
  unblock_network_device: ["mac"],
  decommission_ap: ["mac"],
  approve_ap: ["mac", "ssid", "displayName"],
  add_port_forward: ["name", "src_port", "dest_ip", "dest_port", "proto"],
  set_device_schedule: ["operation", "device_mac"],
  set_phone_home_blocking: ["scope", "enabled", "groupId"],
  set_wifi_ssid: ["ssid"],
  set_wifi_channel: ["channel"],
  set_port_poe: ["port", "enabled"],
  set_port_vlan: ["vlan_id", "mode"],
  setup_camera_ports: ["vlan_id", "camera_ports", "uplink_ports"],
  // Smart home
  control_device: ["node_id", "command"],
  remove_device: ["device"],
  run_scene: ["scene"],
  create_scene: ["name"],
  // Memory, workspace, business records, routines, appointments
  memory_extract_fact: ["category", "fact"],
  memory_forget: ["id"],
  workspace_propose: ["name", "version"],
  business_create: ["entity", "name", "parent_entity", "parent_id"],
  business_update: ["entity", "id", "state", "assignee", "name"],
  business_link: ["from_entity", "from_id", "to_entity", "to_id", "kind"],
  routine_run: ["slug"],
  // The patient is deliberately not shown (an identifier on a health surface).
  erp_schedule_appointment: ["appt_time", "provider_id", "operatory_id"],
};

/**
 * Confirming tools with no argument that is safe and useful to show. Each
 * entry says why, so the waiver is a reviewed decision and not an omission.
 */
export const APPROVAL_NO_SAFE_VALUE: Readonly<Record<string, string>> = {
  email_send:
    "arguments carry only a draft id; the recipients live on the draft (WARP-3010 binds approval to the draft content)",
  set_wifi_password: "the only argument is the password itself, which is never shown",
  commission_device: "the only argument is a pairing code, which is a setup credential",
  restart_router: "takes no arguments",
  detect_wan_port: "takes no arguments",
  apply_update: "takes no arguments",
};

/** Longest shown value, and longest list, before the prompt truncates. */
export const MAX_SHOWN_VALUE_CHARS = 200;
export const MAX_SHOWN_LIST_ITEMS = 10;

// Control characters, line/paragraph separators, zero-width and bidi
// controls: none belongs in a one-line label, and the bidi ones can make a
// path or address read as something else.
// eslint-disable-next-line no-control-regex
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

function cleanForDisplay(raw: string, max: number): string {
  const cleaned = raw.replace(UNSAFE_DISPLAY_CHARS, " ").replace(/ {2,}/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Display text for one allowlisted value, or null when there is nothing to show. */
function shownText(value: unknown): string | null {
  if (typeof value === "string") return cleanForDisplay(value, MAX_SHOWN_VALUE_CHARS) || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => cleanForDisplay(String(v), MAX_SHOWN_VALUE_CHARS / 2))
      .filter((v) => v !== "");
    if (items.length === 0) return null;
    const head = items.slice(0, MAX_SHOWN_LIST_ITEMS).join(", ");
    return items.length > MAX_SHOWN_LIST_ITEMS
      ? `${head}, and ${items.length - MAX_SHOWN_LIST_ITEMS} more`
      : head;
  }
  return null;
}

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(value: unknown): Omit<ConfirmationSummaryField, "key"> {
  if (value === null || value === undefined) {
    return { kind: "null", detail: "empty" };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", detail: value ? "yes" : "no", value };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    // Not the number itself: a "number" is as often a record id, an
    // account number or a date-of-birth stamp as it is a retry count.
    return { kind: "number", detail: "a number" };
  }
  if (typeof value === "string") {
    return { kind: "string", detail: pluralize(value.length, "character", "characters") };
  }
  if (Array.isArray(value)) {
    return { kind: "array", detail: pluralize(value.length, "item", "items") };
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return { kind: "object", detail: pluralize(keys.length, "field", "fields") };
}

/**
 * Describe a tool call for a human. Argument values are reproduced only
 * for the allowlisted keys of {@link APPROVAL_SHOWN_ARGUMENTS}, in `shown`.
 *
 * Keys are sorted so the same call always renders identically — a prompt
 * whose field order depends on the model's JSON key order would make two
 * identical approvals look different.
 */
export function summarizeToolArguments(
  tool: string,
  args: Record<string, unknown>,
): ConfirmationSummary {
  // Backstop FIRST (rule 19). `redactSecretParams` replaces a
  // sensitive-keyed value, and any secret-SHAPED substring, with the
  // fixed placeholder — so when we measure a length below it is the
  // placeholder's length, never the secret's.
  const scrubbed = redactSecretParams(args) as Record<string, unknown>;

  const keys = Object.keys(scrubbed)
    .filter((k) => !CONFIRMATION_SUMMARY_CONTROL_KEYS.includes(k))
    .sort();

  const kept = keys.slice(0, MAX_SUMMARY_FIELDS);
  const shown: ConfirmationShownValue[] = [];
  // Own-property lookup: `tool` is a model-chosen string.
  const allow = Object.hasOwn(APPROVAL_SHOWN_ARGUMENTS, tool) ? APPROVAL_SHOWN_ARGUMENTS[tool]! : [];
  for (const key of allow) {
    const text = shownText(scrubbed[key]);
    if (text !== null) shown.push({ key, text });
  }
  return {
    tool,
    fields: kept.map((key) => ({ key, ...describe(scrubbed[key]) })),
    truncatedFields: keys.length - kept.length,
    shown,
  };
}
