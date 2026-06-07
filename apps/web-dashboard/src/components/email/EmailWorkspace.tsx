"use client";

/**
 * WARP-837 — EmailWorkspace: the 3-column page body.
 *
 * Wires the SWR hooks (useEmailAccounts / useEmailThreads / useEmailThread /
 * useThreadAnalysis) to the three columns (EmailList / EmailThread /
 * EmailAIPanel) and owns account + thread + filter selection. The thin App
 * Router pages render this with optional URL-derived initial ids.
 *
 * Scope (FEATURES.md §2.4): triage + read + a confirm-gated draft send. There
 * is no "add account" / IMAP-cred / off-LAN toggle here — the no-account state
 * points the user at Settings, which owns those.
 *
 * Contract note: no read endpoint returns existing draft rows, so the only
 * draft this surface can SEND is one the user composes here (createDraft returns
 * the row + id). The thread-level "Drafted by Droplet" chip is informational.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Send, Sparkles, X } from "lucide-react";
import {
  useEmailAccounts,
  useEmailThreads,
  useEmailThread,
  useThreadAnalysis,
} from "@/lib/hooks/useEmail";
import { useAuth } from "@/lib/auth";
import { createDraft } from "@/lib/api";
import type { DraftRow, EmailFilter } from "@/lib/types-email";
import { EmailList } from "./EmailList";
import { EmailThread } from "./EmailThread";
import { EmailAIPanel } from "./EmailAIPanel";

interface EmailWorkspaceProps {
  initialAccountId?: string;
  initialThreadId?: string;
}

/** Human "32s ago" / "5m ago" / "2h ago" from an ISO string, or null. */
function relativeSync(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function EmailWorkspace({
  initialAccountId,
  initialThreadId,
}: EmailWorkspaceProps) {
  const router = useRouter();
  const { user } = useAuth();
  const canSend = user?.role === "owner" || user?.role === "admin";

  const { accounts, isLoading: accountsLoading, refresh: refreshAccounts } =
    useEmailAccounts();

  // Resolve the active account: explicit URL id (if it exists), else the first.
  const activeAccountId = useMemo(() => {
    if (initialAccountId && accounts.some((a) => a.id === initialAccountId)) {
      return initialAccountId;
    }
    return accounts[0]?.id ?? null;
  }, [initialAccountId, accounts]);

  const [filter, setFilter] = useState<EmailFilter>("inbox");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    initialThreadId ?? null,
  );
  // A draft created in this session becomes the sendable draft on the thread.
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const {
    threads,
    isLoading: threadsLoading,
    error: threadsError,
    refresh: refreshThreads,
  } = useEmailThreads(activeAccountId, filter);

  const {
    thread,
    isLoading: threadLoading,
    error: threadError,
    refresh: refreshThread,
  } = useEmailThread(activeAccountId, activeThreadId);

  const {
    analysis,
    isLoading: analysisLoading,
    error: analysisError,
    refresh: refreshAnalysis,
  } = useThreadAnalysis(activeAccountId, activeThreadId);

  // Clear any in-progress draft when the user moves to a different thread.
  useEffect(() => {
    setDraft(null);
  }, [activeThreadId, activeAccountId]);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) ?? null;
  const lastSyncLabel = relativeSync(activeAccount?.lastIdleAt ?? null);

  function selectThread(threadId: string) {
    setActiveThreadId(threadId);
    if (activeAccountId) {
      // Keep the URL shareable without forcing a server round-trip.
      router.push(`/email/${activeAccountId}/${threadId}`);
    }
  }

  function handleFilterChange(next: EmailFilter) {
    setFilter(next);
    setActiveThreadId(null);
  }

  // ── No account connected → calm empty state, points at Settings. ──
  if (!accountsLoading && accounts.length === 0) {
    return <NoAccountState />;
  }

  return (
    <div
      className="
        grid min-h-0
        h-[calc(100dvh_-_56px_-_env(safe-area-inset-bottom))] lg:h-dvh
        grid-cols-1
        lg:grid-cols-[300px_minmax(0,1fr)]
        xl:grid-cols-[300px_minmax(0,1fr)_380px]
      "
    >
      {/* Column 1 — list */}
      <EmailList
        accounts={accounts}
        threads={threads}
        filter={filter}
        onFilterChange={handleFilterChange}
        activeThreadId={activeThreadId}
        onSelectThread={selectThread}
        isLoading={accountsLoading || threadsLoading}
        error={threadsError}
        lastSyncLabel={lastSyncLabel}
        onRetry={() => {
          refreshAccounts();
          refreshThreads();
        }}
      />

      {/* Column 2 — thread reader (+ confirm-gated send) */}
      <div className="hidden lg:flex flex-col min-h-0">
        <EmailThread
          thread={activeThreadId ? thread : undefined}
          draft={draft}
          isLoading={Boolean(activeThreadId) && threadLoading}
          error={threadError}
          canSend={canSend}
          onSent={() => {
            setDraft(null);
            refreshThread();
            refreshThreads();
          }}
        />
        {/* Reply composer — the only place a sendable draft is created. */}
        {canSend && activeThreadId && thread && !draft && (
          <ReplyComposer
            accountId={activeAccountId as string}
            threadId={activeThreadId}
            to={replyRecipients(thread.messages, activeAccount?.address)}
            subject={replySubject(thread.subject)}
            onDraftCreated={setDraft}
          />
        )}
      </div>

      {/* Column 3 — AI panel */}
      <div className="hidden xl:flex flex-col min-h-0">
        <EmailAIPanel
          analysis={activeThreadId ? analysis : undefined}
          isLoading={Boolean(activeThreadId) && analysisLoading}
          error={analysisError}
          onRetry={refreshAnalysis}
        />
      </div>
    </div>
  );
}

/** Reply goes back to the most recent inbound sender, falling back to thread participants. */
function replyRecipients(
  messages: { fromAddr: string; toAddrs: string[] }[],
  selfAddress?: string,
): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i].fromAddr;
    if (from && from !== selfAddress) return [from];
  }
  return messages[0]?.toAddrs ?? [];
}

function replySubject(subject: string): string {
  if (!subject) return "Re:";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function NoAccountState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60dvh] p-8 text-center">
      <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-4">
        <Mail size={26} className="text-accent" aria-hidden />
      </span>
      <h1 className="type-title-3 text-label-primary">
        No email account connected yet
      </h1>
      <p className="type-subheadline text-label-tertiary mt-2 max-w-md">
        Once you connect a mailbox in Settings, Droplet will triage your inbox
        and summarise threads here, all on your Droplet.
      </p>
      <a href="/settings" className="dp-btn-secondary text-sm mt-5">
        Go to Settings
      </a>
    </div>
  );
}

function ReplyComposer({
  accountId,
  threadId,
  to,
  subject,
  onDraftCreated,
}: {
  accountId: string;
  threadId: string;
  to: string[];
  subject: string;
  onDraftCreated: (draft: DraftRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createDraft(accountId, {
        threadId,
        toAddrs: to,
        subject,
        body,
      });
      onDraftCreated(created);
      setOpen(false);
      setBody("");
    } catch {
      setError("We couldn't save your draft. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="shrink-0 border-t border-separator px-5 py-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="
            inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg
            bg-surface-secondary border border-separator
            type-footnote text-label-primary
            transition-colors duration-200 ease-smooth
            hover:bg-surface-tertiary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
          "
        >
          <Sparkles size={14} className="text-accent" aria-hidden />
          Write a reply
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-separator px-5 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="type-caption-1 text-label-tertiary">
          Reply to {to.join(", ")}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close reply"
          className="p-1 rounded-md text-label-tertiary hover:text-label-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <label className="sr-only" htmlFor="reply-body">
        Reply message
      </label>
      <textarea
        id="reply-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="Write your reply…"
        className="
          w-full rounded-lg p-2.5 resize-y
          bg-surface-secondary border border-separator
          type-footnote text-label-primary placeholder:text-label-tertiary
          focus:outline-none focus:ring-2 focus:ring-accent/40
        "
      />
      {error && (
        <p role="alert" className="type-caption-1 text-system-red">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !body.trim()}
          className="
            inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg
            bg-accent text-accent-foreground type-footnote font-medium
            transition-colors duration-200 ease-smooth
            hover:bg-accent-hover disabled:opacity-60
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
          "
        >
          <Send size={14} aria-hidden />
          {busy ? "Saving…" : "Save draft"}
        </button>
        <span className="type-caption-2 text-label-tertiary">
          You&rsquo;ll confirm before it sends.
        </span>
      </div>
    </div>
  );
}
