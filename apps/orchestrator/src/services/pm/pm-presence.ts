/**
 * "Also viewing" — who has a work item's drawer open right now (WARP-3536,
 * Work Suite WS-19).
 *
 * The drawer sends a heartbeat every ~10 s; each one is good for 20 s, so one
 * lost beat is forgiven and a closed drawer disappears from everyone else's
 * view within 20 s. Nothing is written when someone leaves: an entry simply
 * stops being renewed.
 *
 * In memory, on purpose. Presence is a soft signal that is wrong by at most one
 * TTL; persisting it would write a row every ten seconds per open drawer for a
 * fact worth nothing a minute later. One orchestrator process serves a box. If
 * that ever changes, viewers on different replicas would simply not see each
 * other (nothing breaks), and this becomes a shared hash.
 *
 * Bounded, because the heartbeat route is reachable by every signed-in member:
 * at most `maxItems` items are tracked at once, and an entry that has expired is
 * dropped the next time anything touches the store. There is no timer; this
 * module starts nothing (WARP-3193 QUAL-7).
 */

/** How long one heartbeat counts. */
export const PRESENCE_TTL_MS = 20_000;

/** Items tracked at once. A box has thousands of work items and a handful of
 *  open drawers; this is a ceiling, never a working size. */
const DEFAULT_MAX_ITEMS = 5_000;

/** The whole map is scanned for expired entries at most this often. */
const PRUNE_EVERY_MS = 5_000;

export interface PresenceStore {
  /** `userId` is looking at `workItemId`: remember it for one TTL. */
  beat(workItemId: string, userId: string): void;
  /** Everyone still looking at `workItemId` except `selfId`, first-seen first. */
  others(workItemId: string, selfId: string): string[];
  /** Items with at least one live viewer. */
  size(): number;
}

export interface PresenceStoreOptions {
  ttlMs?: number;
  maxItems?: number;
  /** Clock seam; defaults to the real one. */
  now?: () => number;
}

export function createPresenceStore(opts: PresenceStoreOptions = {}): PresenceStore {
  const ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const now = opts.now ?? Date.now;

  /** workItemId → (userId → the instant the entry stops counting). */
  const items = new Map<string, Map<string, number>>();
  let lastPrune = now();

  function dropExpired(itemId: string, viewers: Map<string, number>, at: number): void {
    for (const [userId, expiresAt] of viewers) {
      if (expiresAt <= at) viewers.delete(userId);
    }
    if (viewers.size === 0) items.delete(itemId);
  }

  function pruneAll(at: number): void {
    lastPrune = at;
    for (const [itemId, viewers] of items) dropExpired(itemId, viewers, at);
  }

  return {
    beat(workItemId, userId) {
      const at = now();
      if (at - lastPrune >= PRUNE_EVERY_MS) pruneAll(at);

      let viewers = items.get(workItemId);
      if (viewers) {
        // Drop what has expired BEFORE renewing, so a person who let their entry
        // lapse rejoins at the end of the list like any new arrival.
        dropExpired(workItemId, viewers, at);
        viewers = items.get(workItemId);
      }
      if (!viewers) {
        if (items.size >= maxItems) {
          pruneAll(at);
          if (items.size >= maxItems) return; // full of live entries: refuse the new one
        }
        viewers = new Map();
        items.set(workItemId, viewers);
      }
      viewers.set(userId, at + ttlMs);
    },

    others(workItemId, selfId) {
      const viewers = items.get(workItemId);
      if (!viewers) return [];
      dropExpired(workItemId, viewers, now());
      return [...viewers.keys()].filter((userId) => userId !== selfId);
    },

    size() {
      pruneAll(now());
      return items.size;
    },
  };
}

/** The process-wide store the routes use. Tests build their own. */
export const presenceStore: PresenceStore = createPresenceStore();
