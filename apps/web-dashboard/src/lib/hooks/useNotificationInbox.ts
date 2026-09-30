"use client";

/**
 * WARP-3307 — the web notification inbox's data: the unread count for the
 * bell and the newest page of the person's own notifications (routes N1/N2).
 *
 * Live without a second socket: `NotificationToaster` already receives every
 * `droplet/notifications/<user>` message and calls `refreshNotificationInbox`,
 * which revalidates both keys. The poll is only the fallback for a missed
 * message (a dropped socket).
 */

import useSWR, { mutate } from "swr";
import { getNotifications, getUnreadNotificationCount } from "@/lib/api";
import type { NotificationRow, NotificationsPage } from "@/lib/types";

export const NOTIFICATIONS_UNREAD_KEY = "notifications:unread";
export const NOTIFICATIONS_LIST_KEY = "notifications:list";
const POLL_MS = 60_000;
// ponytail: first page only (the box's max is 200). A "load more" can page
// with `nextCursor` once someone keeps more than this many.
export const INBOX_PAGE_SIZE = 100;

export function useUnreadNotificationCount(): number {
  // Called inside the fetcher, never read at render: this renders on every
  // shell page, and a page whose tests mock `@/lib/api` without it must not crash.
  const { data } = useSWR<number>(NOTIFICATIONS_UNREAD_KEY, () => getUnreadNotificationCount(), {
    refreshInterval: POLL_MS,
    shouldRetryOnError: false,
  });
  return data ?? 0;
}

export function useNotificationList() {
  return useSWR<NotificationsPage>(NOTIFICATIONS_LIST_KEY, () => getNotifications({ limit: INBOX_PAGE_SIZE }), {
    refreshInterval: POLL_MS,
  });
}

export function refreshNotificationInbox(): void {
  void mutate(NOTIFICATIONS_UNREAD_KEY);
  void mutate(NOTIFICATIONS_LIST_KEY);
}

/** A notification that waits on the person (a parked background run) and is still unread. */
export function needsDecision(n: NotificationRow): boolean {
  return n.ackState === "unacked" && n.data?.needsDecision === true;
}

/** Decisions first, then everything else in the box's order (newest first). Stable. */
export function sortInbox(rows: readonly NotificationRow[]): NotificationRow[] {
  return [...rows.filter(needsDecision), ...rows.filter((n) => !needsDecision(n))];
}
