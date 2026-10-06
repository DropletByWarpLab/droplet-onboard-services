/**
 * Shared validation for stored owner-chosen box labels. Labels are display
 * metadata; the internal DNS hostname is configured separately.
 *
 * Preserve the existing rules for previously stored labels:
 *   - lowercase DNS-safe slug: `[a-z0-9-]` only
 *   - 3–40 characters
 *   - no leading / trailing / double hyphen
 *   - a reserved blocklist (hq/relay/api/www/admin/mail/vpn/droplet/…)
 *   - reject `d-<16 hex>` system identifier lookalikes
 *
 * We never coerce a bad name into a good one — validation REJECTS so the
 * customer sees their own input, not a silent guess (same discipline as the
 * workspace-slug validator in setup-org.service.ts).
 */

/** Length bounds for existing box labels. */
export const BOX_NAME_MIN_LEN = 3;
export const BOX_NAME_MAX_LEN = 40;

/**
 * Reserved system names retained for compatibility with stored box labels.
 */
export const BOX_NAME_RESERVED: readonly string[] = [
  "hq",
  "relay",
  "api",
  "www",
  "admin",
  "mail",
  "vpn",
  "droplet",
  "app",
  "auth",
  "login",
  "dashboard",
  "status",
  "ns",
  "ns1",
  "ns2",
  "mx",
  "smtp",
  "imap",
  "test",
];

/** Only lowercase letters, digits, and single internal hyphens. Anchored, so a
 *  leading/trailing/double hyphen (or any other character) fails the shape. */
const BOX_NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A customer-chosen label must not look like a system device identifier. */
const DEVICE_LOOKALIKE = /^d-[0-9a-f]{16}$/;

/** Structured reasons a name can be rejected — the dashboard maps these to
 *  inline copy, the orchestrator returns them in the `reason` field. */
export type BoxNameInvalidReason =
  | "empty"
  | "too_short"
  | "too_long"
  | "charset"
  | "hyphen"
  | "reserved"
  | "lookalike";

export interface BoxNameValidation {
  ok: boolean;
  /** The normalized (trimmed + lowercased) slug — what would be persisted. */
  slug: string;
  /** Present only when `ok` is false. */
  reason?: BoxNameInvalidReason;
}

/**
 * Canonical form of a name: trim surrounding whitespace + lowercase. We do NOT
 * substitute or strip internal characters — `validateBoxName` rejects bad input
 * rather than silently rewriting it, so "My Box" stays "my box" (which then
 * fails the charset rule) instead of becoming a surprise "mybox".
 */
export function normalizeBoxName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validate a candidate box name against the shared ruleset. Returns the
 * normalized slug plus a structured reason on failure. Order of checks is
 * deliberate so the reported reason is the most actionable one (charset before
 * the hyphen-shape rule, so "My Box" reports `charset`, not `hyphen`).
 */
export function validateBoxName(raw: string): BoxNameValidation {
  const slug = normalizeBoxName(raw);
  if (slug.length === 0) return { ok: false, slug, reason: "empty" };
  if (slug.length < BOX_NAME_MIN_LEN)
    return { ok: false, slug, reason: "too_short" };
  if (slug.length > BOX_NAME_MAX_LEN)
    return { ok: false, slug, reason: "too_long" };
  // Any character outside [a-z0-9-] is a charset failure. Report it before the
  // hyphen-shape rule so a name with spaces/uppercase reads as "wrong
  // characters" rather than the narrower hyphen message.
  if (!/^[a-z0-9-]+$/.test(slug))
    return { ok: false, slug, reason: "charset" };
  // Now only [a-z0-9-]; a leading/trailing/double hyphen fails the shape.
  if (!BOX_NAME_SHAPE.test(slug))
    return { ok: false, slug, reason: "hyphen" };
  if (DEVICE_LOOKALIKE.test(slug))
    return { ok: false, slug, reason: "lookalike" };
  if (BOX_NAME_RESERVED.includes(slug))
    return { ok: false, slug, reason: "reserved" };
  return { ok: true, slug };
}

/** Convenience predicate for callers that only need the boolean. */
export function isValidBoxName(raw: string): boolean {
  return validateBoxName(raw).ok;
}

/**
 * Human-readable, home-user-friendly copy for each invalid reason. Shared so
 * the dashboard's inline message and any server-surfaced text stay identical.
 */
export function boxNameReasonMessage(reason: BoxNameInvalidReason): string {
  switch (reason) {
    case "empty":
      return "Pick a name for your box.";
    case "too_short":
      return `Use at least ${BOX_NAME_MIN_LEN} characters.`;
    case "too_long":
      return `Keep it to ${BOX_NAME_MAX_LEN} characters or fewer.`;
    case "charset":
      return "Use lowercase letters, numbers, and hyphens only.";
    case "hyphen":
      return "No leading, trailing, or double hyphens.";
    case "reserved":
      return "That name is reserved — pick another.";
    case "lookalike":
      return "That name looks like a system address — pick another.";
    default:
      return "Pick a different name.";
  }
}
