"use client";

/**
 * WARP-2992 — what a tab forgets when the person signed into it leaves.
 *
 * Sign-out is a CLIENT-SIDE navigation (`logout()` then `router.push("/login")`),
 * so the JS heap outlives the session, and so does sessionStorage. Two things
 * in them belonged to the person who had just signed out, and the next person
 * to sign in on the same tab met both:
 *
 *   1. SWR's cache. Every page reads through `useSWR` with keys that name a
 *      resource and never a person (`/api/security/health`, `/api/departments`,
 *      the Security feed's pages), so the next viewer's FIRST render painted
 *      the previous viewer's rows, and revalidation only replaced them after.
 *   2. The chat hand-offs. `PENDING_PROMPT_KEY` is AUTO-SENT by the next fresh
 *      /chat, and `PENDING_COMPOSER_KEY` is left in place on purpose when /chat
 *      was deep-linked (a customer's name and id, pinned). Either one crossed
 *      the sign-out and acted as the next person. sessionStorage survives a
 *      full reload, so a hard navigation to /login would not have cleared it.
 *      WARP-3062 adds two more of the same kind: the /chat composer's unsent
 *      draft (`CHAT_DRAFT_KEY`), and the assistant layout's last place on
 *      each side (`SIDE_STORAGE_KEYS` — a conversation id, a customer page),
 *      which would otherwise hand the next person the last one's text and
 *      links.
 *
 * The third holder, the toast stack, is cleared by `NotificationToaster`: the
 * one layout-level component that sees both the session and the toasts.
 *
 * The cache is emptied with SWR's own `unload()` (`lib/auth.tsx`: `logout()`,
 * authFetch's confirmed-dead path, and a sign-in over a different cached
 * profile). Nothing narrower is enough. Deleting or mutating each key empties
 * the cache at that instant, and a per-key mutation stamp makes a plain
 * `useSWR` answer already in flight discard itself — but a `useSWRInfinite`
 * page answer (the Security feed, events, reviews) is written straight to its
 * page key, past those stamps, so a poll on the wire at sign-out landed A's
 * rows in the cache after it was emptied, and the next person's feed rendered
 * them without asking. `unload()` bumps the cache's unload generation, which
 * the infinite fetcher checks before every page write; drops the fetch and
 * preload markers, so an in-flight plain read or preload is discarded when it
 * lands; overwrites every mutation stamp, so an in-flight mutation is too;
 * deletes every key, `$inf$` and `$sub$` included; and drops the data
 * `keepPreviousData` holds on screen.
 */
import { CHAT_DRAFT_KEY, PENDING_COMPOSER_KEY, PENDING_PROMPT_KEY } from "./types";
import { SIDE_STORAGE_KEYS } from "./assistant-side";

/** Drop the chat hand-offs, the unsent draft and the assistant layout's
 *  remembered places (see the module note). */
export function clearChatHandoffs(): void {
  for (const key of [
    PENDING_PROMPT_KEY,
    PENDING_COMPOSER_KEY,
    CHAT_DRAFT_KEY,
    SIDE_STORAGE_KEYS.ask,
    SIDE_STORAGE_KEYS.business,
  ]) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* storage blocked — nothing could have been handed off */
    }
  }
}
