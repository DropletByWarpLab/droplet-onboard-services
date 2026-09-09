/**
 * WARP-2519 — how a failed connection-lifecycle call is put into words.
 *
 * ## Why this exists
 *
 * The lifecycle handlers on the practice surface were `try { … } catch {}`:
 * a disconnect or a write-toggle that the box refused produced no message, no
 * banner and no console line, and the following `refresh()` re-rendered the
 * unchanged connection. From the owner's side that is indistinguishable from
 * a button that does nothing — the same class of silent no-op WARP-2291
 * removed from the hub's dispatch, one layer further in. `catch {}` is worse
 * than an unhandled rejection here, because it also hides the failure from the
 * console.
 *
 * ## What it may say, and what it may never say
 *
 * The detail is built from the typed `code`/`status` `apiFetch` attaches, NEVER
 * from the response body — the same rule and the same reasoning as
 * `fetchErrorMessage` in `hooks/useIntegrations.ts`. A lifecycle call's body
 * can echo the request, and these routes carry credential-bearing connections,
 * so anything the server happened to include must not reach the DOM (rule 19).
 * `TypedError.body` is deliberately not read, and neither is `Error.message`,
 * which on a non-typed throw is whatever the runtime put there.
 *
 * It also makes no claim about what the box did. "Nothing was changed" would be
 * a guess — a 500 can arrive after a partial write — so the sentence ends at
 * what is actually known: the call failed, and it can be tried again.
 */

import type { TypedError } from "./hooks/apiFetch";

/**
 * @param action a verb phrase naming what was attempted, in the owner's words
 *   — "disconnect Eaglesoft", "turn writes on". Never a URL, a method or a
 *   provider key.
 */
export function lifecycleErrorMessage(action: string, err: unknown): string {
  const typed = err as TypedError | null | undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  // `status: 0` is what apiFetch stamps on a timeout/abort, where the code is
  // the informative half — so a falsy status contributes nothing.
  const status =
    typeof typed?.status === "number" && typed.status > 0
      ? `HTTP ${typed.status}`
      : undefined;
  const detail = code ?? status;
  return detail
    ? `Couldn't ${action} (${detail}). Try again.`
    : `Couldn't ${action}. Try again.`;
}
