"use client";

/**
 * /notifications — WARP-3307, the web inbox. The person's own notifications,
 * newest first, with anything that waits on a decision (a parked background
 * run, `data.needsDecision`) pinned to the top while it is unread.
 *
 * Mirrors the iOS inbox and the toaster:
 *   · "Open" acknowledges as `opened` (fire-and-forget) and navigates — only
 *     to an in-app path (`isInAppPath`).
 *   · "Mark read" acknowledges as `inbox`.
 *   · "Mark all read" sends the ids that were SHOWN (N4 never takes a time
 *     bound: a late-committed row must stay unread).
 * Live via NotificationToaster → refreshNotificationInbox. No role gate: every
 * signed-in person has notifications, and N1 only returns their own.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card } from "@/components/shell/primitives";
import { isInAppPath } from "@/components/NotificationToaster";
import { ackAllNotifications, ackNotification } from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  needsDecision,
  refreshNotificationInbox,
  sortInbox,
  useNotificationList,
} from "@/lib/hooks/useNotificationInbox";
import type { NotificationRow } from "@/lib/types";

export default function NotificationsPage() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useNotificationList();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = sortInbox(data?.notifications ?? []);
  const unreadShown = rows.filter((n) => n.ackState === "unacked").map((n) => n.id);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch {
      setActionError("That didn't go through. Try again.");
    } finally {
      setBusy(false);
      refreshNotificationInbox();
    }
  };

  const open = (n: NotificationRow) => {
    if (!n.url || !isInAppPath(n.url)) return;
    if (n.ackState === "unacked") void ackNotification(n.id, { via: "opened" }).catch(() => {}).finally(refreshNotificationInbox);
    router.push(n.url);
  };

  const actions = (
    <button
      type="button"
      className="btn"
      disabled={busy || unreadShown.length === 0}
      onClick={() => act(() => ackAllNotifications(unreadShown))}
    >
      Mark all read
    </button>
  );

  return (
    <ShellPage icon={<Bell size={15} />} label="Notifications" title="Notifications" sub={data ? `${data.unread} unread` : undefined} actions={actions}>
      {actionError ? (
        <p role="alert" className="inbox-msg">
          {actionError}
        </p>
      ) : null}
      {error && !data ? (
        <Card>
          <p role="alert" className="inbox-msg">
            Notifications could not be loaded.
          </p>
          <button type="button" className="btn" onClick={() => void mutate()}>
            Retry
          </button>
        </Card>
      ) : isLoading && !data ? (
        <p className="inbox-msg" aria-busy="true">
          Loading notifications…
        </p>
      ) : rows.length === 0 ? (
        <Card>
          <p className="inbox-msg">No notifications yet. Reminders, shares and background runs that need you show up here.</p>
        </Card>
      ) : (
        <ul className="inbox-list" aria-label="Notifications">
          {rows.map((n) => {
            const unread = n.ackState === "unacked";
            const canOpen = !!n.url && isInAppPath(n.url);
            return (
              <li key={n.id} className={"inbox-row" + (unread ? " is-unread" : "")} data-testid="inbox-row">
                <span className="inbox-dot" aria-hidden="true" />
                <div className="inbox-tx">
                  <div className="inbox-title">
                    <span>{n.title}</span>
                    {needsDecision(n) ? <Badge kind="warn">Needs your OK</Badge> : null}
                    {unread ? <span className="sr-only">(unread)</span> : null}
                  </div>
                  {n.body ? <p className="inbox-body">{n.body}</p> : null}
                  <time className="inbox-time" dateTime={n.createdAt}>
                    {formatRelativeTime(n.createdAt)}
                  </time>
                </div>
                <div className="inbox-actions">
                  {canOpen ? (
                    <button type="button" className="btn primary" onClick={() => open(n)} aria-label={`Open: ${n.title}`}>
                      Open
                    </button>
                  ) : null}
                  {unread ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => act(() => ackNotification(n.id))}
                      aria-label={`Mark read: ${n.title}`}
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ShellPage>
  );
}
