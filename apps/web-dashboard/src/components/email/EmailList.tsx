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
 *
 * WARP-1088 — indigo shell: the search box onto the shared `.search` idiom,
 * the Inbox/Triaged/From Droplet filter group onto `.pills` (segmented
 * control — same aria-pressed/role="group" shape as the calendar view and
 * report-range toggles), rows onto `.lrow`, and the "Drafted by Droplet"
 * marker onto `.badge info` (droplet-shell.css / indigo-tokens.css). Pure
 * recolor/reclass — no behavior change.
 */

import { useMemo, useState } from "react";
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

  // Lightweight client-side filter over the already-loaded threads — matches
  // subject or sender, case-insensitive. No new fetch; the search just narrows
  // what is on screen, so it stays instant and offline-safe.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleThreads = useMemo(() => {
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.subject.toLowerCase().includes(q) ||
        (t.lastSender ?? "").toLowerCase().includes(q),
    );
  }, [threads, q]);
  const noMatches = q.length > 0 && visibleThreads.length === 0;

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ borderRight: "1px solid var(--border)", background: "var(--surface)" }}
    >
      {/* Header — account summary, search, filter chips. */}
      <div
        className="shrink-0 px-4 pt-4 pb-3 space-y-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div>
          <h1 className="type-headline" style={{ color: "var(--text)" }}>Email</h1>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            {accountCount} {accountWord}
            {sync}
          </p>
        </div>

        <label className="search">
          <span style={{ display: "flex", flexShrink: 0, color: "var(--text-muted)" }}>
            <Search size={14} aria-hidden />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
        </label>

        <div className="pills" role="group" aria-label="Filter messages">
          {FILTERS.map(({ slug, label }) => {
            const active = slug === filter;
            return (
              <button
                key={slug}
                type="button"
                onClick={() => onFilterChange(slug)}
                aria-pressed={active}
                className={active ? "active" : ""}
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
                className="h-16 rounded-lg animate-pulse"
                style={{ background: "var(--inset)" }}
              />
            ))}
          </ul>
        ) : error ? (
          <div className="p-6 text-center" role="alert">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              We couldn&rsquo;t load your messages
            </p>
            <p className="type-footnote mt-1" style={{ color: "var(--text-muted)" }}>
              This usually clears up on its own.
            </p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="btn sm mt-3">
                Try again
              </button>
            )}
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center">
            <Inbox
              size={28}
              className="mx-auto mb-2"
              style={{ color: "var(--text-faint)" }}
              aria-hidden
            />
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              No messages here
            </p>
            <p
              className="type-footnote mt-1 max-w-[220px] mx-auto"
              style={{ color: "var(--text-muted)" }}
            >
              {filter === "droplet"
                ? "Drafts Droplet writes for you will show up here."
                : "Nothing in this view right now."}
            </p>
          </div>
        ) : noMatches ? (
          <div className="p-8 text-center">
            <Search
              size={26}
              className="mx-auto mb-2"
              style={{ color: "var(--text-faint)" }}
              aria-hidden
            />
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              No matches
            </p>
            <p
              className="type-footnote mt-1 max-w-[220px] mx-auto"
              style={{ color: "var(--text-muted)" }}
            >
              No threads match &ldquo;{query.trim()}&rdquo; in this view.
            </p>
          </div>
        ) : (
          <ul className="py-1">
            {visibleThreads.map((t) => (
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
      className={`lrow w-full text-left border-l-2 transition-colors duration-200 ease-smooth ${
        active ? "" : "hover:bg-[var(--hover)]"
      }`}
      style={{
        borderLeftColor: active ? "var(--brand)" : "transparent",
        background: active ? "var(--brand-subtle)" : undefined,
      }}
    >
      {/* Unread dot rail — fixed width so subjects stay aligned read or unread. */}
      <span className="shrink-0 w-2" aria-hidden>
        {unread && (
          <span
            className="block w-2 h-2 rounded-full"
            style={{ background: "var(--brand)" }}
          />
        )}
      </span>

      <span className="rt">
        <span className="flex items-baseline gap-2">
          <span
            className="truncate"
            style={{
              fontSize: "13.5px",
              fontWeight: unread ? 600 : 500,
              color: unread ? "var(--text)" : "var(--text-muted)",
            }}
          >
            {sender}
          </span>
          <span
            className="rmeta mono ml-auto shrink-0 tabular-nums"
          >
            {formatRowTime(thread.lastMessageAt)}
          </span>
        </span>

        <span
          className="block truncate type-subheadline mt-0.5"
          style={{ color: unread ? "var(--text)" : "var(--text-muted)" }}
        >
          {thread.subject || "(no subject)"}
        </span>

        {thread.snippet && (
          <span className="sub truncate">{thread.snippet}</span>
        )}

        {thread.draftedByDroplet && (
          <span className="badge info" style={{ marginTop: 6 }}>
            <Sparkles size={10} aria-hidden />
            Drafted by Droplet
          </span>
        )}
      </span>
    </button>
  );
}
