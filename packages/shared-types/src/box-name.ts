/**
 * WARP-979 — shared box-name validation.
 *
 * The setup walkthrough's "Secured / name your box" step (SetSecured in the
 * design handoff) lets the owner TYPE a name that becomes their box's
 * publicly-trusted address `<name>.droplet-us.com` (green padlock, zero
 * install). Both the DASHBOARD (live client-side validation + availability
 * check) and the ORCHESTRATOR (server-side re-validation before persisting +
 * before the name is sent to HQ) must agree on the exact same rules — so the
 * rules live HERE, in the package both apps already depend on
 * (`@droplet/shared-types`), and are imported on both sides.
 *
 * The ruleset mirrors the fleet-HQ `names.ts` contract (the authority that
 * ultimately reserves the name in the fleet registry):
 *   - lowercase DNS-safe slug: `[a-z0-9-]` only
 *   - 3–40 characters
 *   - no leading / trailing / double hyphen
 *   - a reserved blocklist (hq/relay/api/www/admin/mail/vpn/droplet/…)
 *   - reject `d-<16 hex>` lookalikes — that shape is the opaque per-device
 *     identifier HQ auto-mints (ADR-023 `d-<hmac>.…`); a customer name must
 *     never collide with or impersonate one.
 *
 * We never coerce a bad name into a good one — validation REJECTS so the
 * customer sees their own input, not a silent guess (same discipline as the
 * workspace-slug validator in setup-org.service.ts).
 */

/** The public suffix every named box resolves under. NOT the handoff's
 *  `.devices.warp-lab.ai` — our production domain is `droplet-us.com`. */
export const BOX_NAME_SUFFIX = ".droplet-us.com";

/** Length bounds (DNS-label friendly; HQ mirrors these). */
export const BOX_NAME_MIN_LEN = 3;
export const BOX_NAME_MAX_LEN = 40;

/**
 * Names that collide with fleet infrastructure hosts / platform routes, so a
 * customer can't claim them. Kept small + explicit; extend deliberately (a name
 * check is cheap, a reserved-word collision in production is not). Mirrors the
 * HQ `RESERVED` list.
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

/** The opaque per-device identifier shape HQ auto-mints (`d-<16 hex>`, ADR-023).
 *  A customer-chosen name must never look like one. */
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

/** The full FQDN a valid name resolves to, e.g. `studio.droplet-us.com`. */
export function boxNameToFqdn(slug: string): string {
  return `${slug}${BOX_NAME_SUFFIX}`;
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
