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
 * TRADE-OFF, stated so nobody has to re-derive it: this means the user
 * approving `delete_file` sees "path — 24 characters", not the path.
 * That is deliberately conservative. Showing selected values requires a
 * per-tool, per-argument allowlist of fields known never to carry
 * customer content, which is a human decision about 134 tools and is
 * filed as a follow-up rather than guessed at here.
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
 * Describe a tool call for a human, without reproducing any argument
 * value.
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
  return {
    tool,
    fields: kept.map((key) => ({ key, ...describe(scrubbed[key]) })),
    truncatedFields: keys.length - kept.length,
  };
}
