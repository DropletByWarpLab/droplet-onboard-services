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
 *
 * The third holder, the toast stack, is cleared by `NotificationToaster`: the
 * one layout-level component that sees both the session and the toasts.
 *
 * The dashboard mounts no `SWRConfig` provider (only tests do), so every page
 * and the global `mutate` imports share SWR's default cache — the one
 * `SWRConfig.defaultValue` names. `logout()` passes the cache in its own scope
 * instead, which is the same one today and stays right if a provider is ever
 * mounted above `AuthProvider`.
 */
import { SWRConfig, type Cache, type ScopedMutator } from "swr";
import { PENDING_COMPOSER_KEY, PENDING_PROMPT_KEY } from "./types";

export interface SwrClearOptions {
  /**
   * `true` also drops SWR's in-flight/dedupe markers. Without that, a hook
   * mounted within `dedupingInterval` (2 s) of the old session's last answer
   * is handed THAT answer, the mutation stamp below discards it, and the hook
   * sits empty until its next poll or focus — the next person's Security page
   * reading "nothing happened". But it also refetches every hook still
   * mounted on a key, so pass `true` only once the signed-in tree is gone
   * (`logout()`), and `false` while it is still up (`authFetch`'s bounce,
   * where a refetch is one more 401 on the way to /login).
   */
  revalidate: boolean;
}

/**
 * Empty every entry of `cache` — INCLUDING the `$inf$` (useSWRInfinite) keys.
 *
 * Not `mutate(() => true, undefined, …)`: SWR's key-filter form skips every
 * `$inf$`/`$sub$` key (`/^\$(inf|sub)\$/` in its mutate), and the Security
 * feed — camera and door-lock rows — lives under one. Mutating each key by its
 * serialized name reaches them all.
 *
 * `mutate` first, not a bare `cache.delete`: it tells every mounted hook, so a
 * page still on screen renders empty instead of keeping its rows, and it
 * stamps the key's mutation time, so an answer the old session asked for
 * before this call is DISCARDED when it lands instead of being written back.
 * Then the entries are deleted, so nothing of the old session (an infinite
 * list's page count, a cursor in a key) is left for the next hooks to start
 * from.
 */
export async function clearSwrCache(
  cache: Cache,
  mutate: ScopedMutator,
  { revalidate }: SwrClearOptions,
): Promise<void> {
  const keys = Array.from(cache.keys());
  await Promise.all(keys.map((key) => mutate(key, undefined, { revalidate })));
  for (const key of keys) cache.delete(key);
}

/** Drop the one-shot chat hand-offs (see the module note). */
export function clearChatHandoffs(): void {
  for (const key of [PENDING_PROMPT_KEY, PENDING_COMPOSER_KEY]) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* storage blocked — nothing could have been handed off */
    }
  }
}

/** Everything above, for the session that just ended. */
export async function clearSignedInState({
  cache = SWRConfig.defaultValue.cache,
  mutate = SWRConfig.defaultValue.mutate,
  revalidate,
}: Partial<{ cache: Cache; mutate: ScopedMutator }> & SwrClearOptions): Promise<void> {
  clearChatHandoffs();
  await clearSwrCache(cache, mutate, { revalidate });
}
