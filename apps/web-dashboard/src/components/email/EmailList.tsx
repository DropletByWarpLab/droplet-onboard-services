"use client";

/**
 * WARP-837 — EmailList (column 1 of the 3-column mail client).
 *
 * Ports FEATURES.md §2.4 list column: an account summary header
 * ("N accounts · last sync …"), three filter chips (Inbox / Triaged / From
 * Droplet — the backend's 4th `archived` is intentionally out of v1 scope),
 * and one row per thread (sender · time · subject · preview · unread dot ·
 * drafted-by-Droplet badge).
 *
 * Presentational: the page owns the SWR hooks and passes data + callbacks in,
 * which keeps this trivially testable and free of fetch concerns.
 */

import { Inbox, Search, Sparkles } from "lucide-react";
import type { EmailAccount, EmailFilter, ThreadSummary } from "@/lib/types-email";

const FILTERS: { slug: EmailFilter; label: string }[] = [
  { slug: "inbox", label: "Inbox" },
  { slug: "triaged", label: "Triaged" },
  { slug: "droplet", label: "From Droplet" },
];

interface EmailListProps {
  accounts: EmailAccount[];
  threads: ThreadSummary[];
  filter: EmailFilter;
  onFilterChange: (filter: EmailFilter) => void;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  isLoading: boolean;
  error?: Error;
  /** Pre-formatted "32s ago" / "5m ago" string, or null when never synced. */
  lastSyncLabel?: string | null;
  onRetry?: () => void;
}

/** "Today 10:32" / "Yesterday" / "Mon" — compact, calm, no seconds. */
function formatRowTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function EmailList({
  accounts,
  threads,
  filter,
  onFilterChange,
  activeThreadId,
  onSelectThread,
  isLoading,
  error,
  lastSyncLabel,
  onRetry,
}: EmailListProps) {
  const accountCount = accounts.length;
  const accountWord = accountCount === 1 ? "account" : "accounts";
  const sync = lastSyncLabel ? ` · last sync ${lastSyncLabel}` : "";
  const searchPlaceholder =
    accountCount === 1 ? "Search inbox" : `Search ${accountCount} inboxes`;

  return (
    <div className="flex flex-col h-full min-h-0 border-r border-separator bg-surface-primary">
      {/* Header — account summary, search, filter chips. */}
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3 border-b border-separator">
        <div>
          <h1 className="type-headline text-label-primary">Email</h1>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            {accountCount} {accountWord}
            {sync}
          </p>
        </div>

        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-label-tertiary pointer-events-none"
            aria-hidden
          />
          <input
            type="search"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="
              w-full h-9 pl-8 pr-3 rounded-lg
              bg-surface-secondary border border-separator
              type-footnote text-label-primary placeholder:text-label-tertiary
              focus:outline-none focus:ring-2 focus:ring-accent/40
              transition-colors duration-200 ease-smooth
            "
          />
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter messages">
          {FILTERS.map(({ slug, label }) => {
            const active = slug === filter;
            return (
              <button
                key={slug}
                type="button"
                onClick={() => onFilterChange(slug)}
                aria-pressed={active}
                className={`
                  inline-flex items-center h-7 px-2.5 rounded-full border
                  type-caption-1 transition-colors duration-200 ease-smooth
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                  ${
                    active
                      ? "bg-accent-subtle border-accent/30 text-accent font-medium"
                      : "bg-surface-secondary border-separator text-label-secondary hover:text-label-primary"
                  }
                `}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body — rows / loading / empty / error. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <ul aria-label="Loading messages" className="p-2 space-y-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="h-16 rounded-lg bg-surface-secondary animate-pulse"
              />
            ))}
          </ul>
        ) : error ? (
          <div className="p-6 text-center" role="alert">
            <p className="type-subheadline text-label-primary">
              We couldn&rsquo;t load your messages
            </p>
            <p className="type-footnote text-label-tertiary mt-1">
              This usually clears up on its own.
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="dp-btn-secondary text-sm mt-3"
              >
                Try again
              </button>
            )}
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center">
            <Inbox
              size={28}
              className="mx-auto text-label-quaternary mb-2"
              aria-hidden
            />
            <p className="type-subheadline text-label-primary">
              No messages here
            </p>
            <p className="type-footnote text-label-tertiary mt-1 max-w-[220px] mx-auto">
              {filter === "droplet"
                ? "Drafts Droplet writes for you will show up here."
                : "Nothing in this view right now."}
            </p>
          </div>
        ) : (
          <ul className="py-1">
            {threads.map((t) => (
              <li key={t.id}>
                <EmailRow
                  thread={t}
                  active={t.id === activeThreadId}
                  onSelect={() => onSelectThread(t.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmailRow({
  thread,
  active,
  onSelect,
}: {
  thread: ThreadSummary;
  active: boolean;
  onSelect: () => void;
}) {
  // A thread is "unread" if its newest message hasn't been opened. The backbone
  // doesn't yet expose a per-thread read flag, so we treat an inbox thread the
  // user hasn't selected as unread for the dot affordance — honest about what we
  // know, and the dot simply clears on selection.
  const unread = thread.triageStatus === "inbox" && !active;
  const sender = thread.lastSender ?? "Unknown sender";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`
        group w-full text-left px-4 py-2.5 flex gap-2.5 min-h-[44px]
        border-l-2 transition-colors duration-200 ease-smooth
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40
        ${
          active
            ? "bg-accent-subtle border-l-accent"
            : "border-l-transparent hover:bg-surface-secondary"
        }
      `}
    >
      {/* Unread dot rail — fixed width so subjects stay aligned read or unread. */}
      <span className="shrink-0 w-2 pt-1.5" aria-hidden>
        {unread && (
          <span className="block w-2 h-2 rounded-full bg-accent" />
        )}
      </span>

      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2">
          <span
            className={`type-footnote truncate ${
              unread
                ? "text-label-primary font-semibold"
                : "text-label-secondary"
            }`}
          >
            {sender}
          </span>
          <span className="ml-auto shrink-0 type-caption-2 text-label-tertiary tabular-nums">
            {formatRowTime(thread.lastMessageAt)}
          </span>
        </span>

        <span
          className={`block truncate type-subheadline mt-0.5 ${
            unread ? "text-label-primary" : "text-label-secondary"
          }`}
        >
          {thread.subject || "(no subject)"}
        </span>

        {thread.snippet && (
          <span className="block truncate type-caption-1 text-label-tertiary mt-0.5">
            {thread.snippet}
          </span>
        )}

        {thread.draftedByDroplet && (
          <span className="inline-flex items-center gap-1 mt-1.5 h-5 px-1.5 rounded-full bg-accent-subtle type-caption-2 font-medium text-accent">
            <Sparkles size={10} aria-hidden />
            Drafted by Droplet
          </span>
        )}
      </span>
    </button>
  );
}
