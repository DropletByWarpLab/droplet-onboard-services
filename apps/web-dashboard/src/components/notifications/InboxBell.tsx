"use client";

/**
 * WARP-3307 — the notification inbox's way in: a bell in every shell page's
 * slim top bar with the unread count.
 */

import Link from "next/link";
import { Bell } from "lucide-react";
import { useUnreadNotificationCount } from "@/lib/hooks/useNotificationInbox";

export function InboxBell() {
  const unread = useUnreadNotificationCount();
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Link href="/notifications" className="pt-bell" aria-label={label} title={label}>
      <Bell size={15} aria-hidden="true" />
      {unread > 0 ? (
        <span className="pt-bell-n" aria-hidden="true">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
