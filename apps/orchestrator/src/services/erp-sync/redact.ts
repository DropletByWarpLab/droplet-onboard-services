/**
 * WARP-2218 — make a connector sync failure safe to persist and render.
 *
 * `ErpSyncCursor.lastError` is shown to an operator, so rule 19 (never log a
 * captured secret) applies to it exactly as it applies to a log line. The
 * repo's machinery is `lib/log-redaction.ts`; this wraps it rather than
 * re-implementing "what counts as a secret", so the two cannot drift.
 *
 * Two shapes `redactSecrets` cannot see on its own, and why they matter here:
 *
 *  1. **A bare vendor credential with no key name.** `redactSecrets` finds
 *     `API_KEY=…` and `Authorization: Bearer …` because it matches on the KEY.
 *     A vendor's own error text carries the credential naked — Stripe echoes
 *     the key that failed, and `rk_live_…` in a sentence has no assignment for
 *     the generic rules to anchor on. These prefixes are recognisable on their
 *     own, so they get their own rule.
 *  2. **Pagination cursors.** A page token reads as harmless URL noise but it
 *     is bearer material for the position it names, and it is exactly what a
 *     sync failure's message tends to contain.
 */
import { redactSecrets, REDACTION_PLACEHOLDER } from "../../lib/log-redaction.js";
import type { SyncFailureLike } from "../m365/sync-policy.js";

/**
 * Live-credential prefixes that identify a secret with no surrounding key.
 *
 * An ALLOWLIST of shapes we know, deliberately paired with the generic
 * key-name rules rather than replacing them: a prefix we have not met yet
 * still gets caught by `redactSecrets` whenever it appears as
 * `something_key=…`. Both halves are needed; neither is sufficient.
 *
 *   sk_/rk_/pk_  Stripe (secret / restricted / publishable, live and test)
 *   pat-         HubSpot private-app token
 *   xoxb-/xoxp-  Slack bot / user token
 *   AIza         Google API key
 *   ya29.        Google OAuth access token
 */
const BARE_CREDENTIAL_RE =
  /\b((?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{4,}|pat-[a-z0-9]+-[A-Za-z0-9-]{8,}|xox[bp]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9._-]{10,})/g;

/** Pagination / continuation tokens, whatever the vendor calls them. */
const CURSOR_PARAM_RE =
  /\b(after|starting_after|ending_before|page_?token|next_?cursor|cursor|continuation|\$(?:delta|skip)token)=([^\s&"']+)/gi;

/** Cap so one vendor's essay cannot fill the column. */
const MAX_ERROR_LEN = 500;

/**
 * Scrub free text bound for `lastError` or a drift report.
 *
 * Order matters: the bare-credential rule runs BEFORE `redactSecrets`, because
 * a naked `sk_live_…` inside an `Authorization:` header would otherwise be
 * replaced by the generic placeholder first and the specific rule would have
 * nothing left to prove it worked. Running it first is also the fail-closed
 * order — a value that matches both rules is redacted by whichever fires.
 */
export function redactSyncText(text: string): string {
  if (!text) return "";
  let out = text.replace(BARE_CREDENTIAL_RE, REDACTION_PLACEHOLDER);
  out = out.replace(CURSOR_PARAM_RE, (_m, key: string) => `${key}=${REDACTION_PLACEHOLDER}`);
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
