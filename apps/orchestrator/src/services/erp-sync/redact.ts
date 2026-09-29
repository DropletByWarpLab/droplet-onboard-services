/**
 * WARP-2218 — make a connector sync failure safe to persist and render.
 *
 * `ErpSyncCursor.lastError` is shown to an operator, so rule 19 (never log a
 * captured secret) applies to it exactly as it applies to a log line. The
 * repo's machinery is `lib/log-redaction.ts`; this wraps it rather than
 * re-implementing "what counts as a secret", so the two cannot drift.
 *
 * Two shapes that matter here, and where each is handled:
 *
 *  1. **A bare vendor credential with no key name.** A vendor's own error
 *     text carries the credential naked — Stripe echoes the key that failed,
 *     and `rk_live_…` in a sentence has no assignment to anchor on. WARP-3282
 *     moved these prefixes (Stripe `sk_/rk_/pk_`, HubSpot `pat-`, Slack
 *     `xox?-`, Google `AIza`/`ya29.`) into the shared credential-shape list in
 *     `lib/log-redaction.ts`, which `redactSecrets` runs first — so there is
 *     one list, and a prefix added there covers this column too.
 *  2. **Pagination cursors.** A page token reads as harmless URL noise but it
 *     is bearer material for the position it names, and it is exactly what a
 *     sync failure's message tends to contain.
 */
import { redactSecrets, REDACTION_PLACEHOLDER } from "../../lib/log-redaction.js";
import type { SyncFailureLike } from "../m365/sync-policy.js";

/** Pagination / continuation tokens, whatever the vendor calls them. */
const CURSOR_PARAM_RE =
  /\b(after|starting_after|ending_before|page_?token|next_?cursor|cursor|continuation|\$(?:delta|skip)token)=([^\s&"']+)/gi;

/** Cap so one vendor's essay cannot fill the column. */
const MAX_ERROR_LEN = 500;

/** Scrub free text bound for `lastError` or a drift report. */
export function redactSyncText(text: string): string {
  if (!text) return "";
  let out = text.replace(CURSOR_PARAM_RE, (_m, key: string) => `${key}=${REDACTION_PLACEHOLDER}`);
  out = redactSecrets(out);
  return out.length > MAX_ERROR_LEN ? `${out.slice(0, MAX_ERROR_LEN - 1)}…` : out;
}

/**
 * Render a sync failure into the one operator-facing sentence the column
 * holds. Keeps the vendor's error code, which is the part that makes a
 * support search possible, and never the credential that produced it.
 */
export function redactSyncErrorText(err: SyncFailureLike): string {
  const parts = [
    err.code ? String(err.code).trim() : "",
    typeof err.statusCode === "number" ? `HTTP ${err.statusCode}` : "",
    err.message ? String(err.message).trim() : "",
  ].filter(Boolean);
  const combined = parts.join(": ");
  if (!combined) return "The connector failed without giving a reason.";
  return redactSyncText(combined);
}
