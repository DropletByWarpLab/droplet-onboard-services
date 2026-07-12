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
import { ChevronDown, ChevronLeft, Mail, Send, Sparkles, X } from "lucide-react";
import {
  useEmailAccounts,
  useEmailThreads,
  useEmailThread,
  useThreadAnalysis,
} from "@/lib/hooks/useEmail";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { useAuth } from "@/lib/auth";
import { createDraft } from "@/lib/api";
import type { DraftRow, EmailFilter } from "@/lib/types-email";
import { EmailList } from "./EmailList";
import { EmailThread } from "./EmailThread";
import { EmailAIPanel } from "./EmailAIPanel";
// WARP-1088 — /email is its own workspace frame (not a ShellPage, same as
// /chat), so it must bring the shared indigo tokens + primitive classes
// (.card/.lrow/.chip/.btn/.badge/…) into scope itself via `.droplet-shell`
// on the root below.
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";

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

  // Layout breakpoints, mirrored from the Tailwind grid below so the rendered
  // panes and the CSS column template stay in lock-step:
  //   isDesktop (lg, ≥1024px) → list + thread reader columns are both present.
  //   isWide    (xl, ≥1280px) → the AI panel is a permanent third column.
  // Below lg we render a single active pane (list OR reader); below xl the AI
  // panel is reachable via an inline disclosure instead of a dead column.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1280px)");

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

  // Mobile "back to inbox": clear the selection so the single pane returns to
  // the list, and drop the thread segment from the URL.
  function clearThread() {
    setActiveThreadId(null);
    if (activeAccountId) {
      router.push(`/email/${activeAccountId}`);
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

  // Single-pane routing below lg: the list owns the pane until a thread is
  // selected, then the reader does. On desktop both panes are always present.
  const hasSelection = Boolean(activeThreadId);
  const showList = isDesktop || !hasSelection;
  const showReader = isDesktop || hasSelection;

  return (
    <div
      className="
        droplet-shell
        grid min-h-0
        h-[calc(100dvh_-_56px_-_env(safe-area-inset-bottom))] lg:h-dvh
        grid-cols-1
        lg:grid-cols-[300px_minmax(0,1fr)]
        xl:grid-cols-[300px_minmax(0,1fr)_380px]
      "
    >
      {/* Column 1 — list (hidden below lg once a thread is open). */}
      {showList && (
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
      )}

      {/* Column 2 — thread reader (+ confirm-gated send). Below lg this is the
          active pane only when a thread is selected, and carries the back
          control + the AI disclosure so neither is stranded behind display:none. */}
      {showReader && (
        <div className="flex flex-col min-h-0">
          {/* Mobile-only "back to inbox" — never rendered on desktop, where the
              list is always visible beside the reader. */}
          {!isDesktop && hasSelection && (
            <div
              className="shrink-0 px-2 py-1.5"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <button
                type="button"
                onClick={clearThread}
                className="
                  inline-flex items-center gap-1 min-h-[44px] px-2 rounded-lg
                  type-footnote
                  transition-colors duration-200 ease-smooth
                  hover:text-[color:var(--text)]
                "
                style={{ color: "var(--text-muted)" }}
              >
                <ChevronLeft size={16} aria-hidden />
                Back to inbox
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
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

          {/* AI panel as an inline disclosure below xl, where it has no column.
              Only when a thread is open — there's nothing to summarise otherwise. */}
          {!isWide && hasSelection && (
            <AIPanelDisclosure
              analysis={analysis}
              isLoading={analysisLoading}
              error={analysisError}
              onRetry={refreshAnalysis}
            />
          )}
        </div>
      )}

      {/* Column 3 — AI panel, a permanent column at xl+. */}
      {isWide && (
        <div className="flex flex-col min-h-0">
          <EmailAIPanel
            analysis={activeThreadId ? analysis : undefined}
            isLoading={Boolean(activeThreadId) && analysisLoading}
            error={analysisError}
            onRetry={refreshAnalysis}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The AI side panel surfaced as a bottom disclosure below xl, where it has no
 * column of its own. Collapsed by default so the thread reader keeps the height;
 * the customer opens it on demand. Reuses EmailAIPanel verbatim once open, so the
 * §6 safety chips and the read-only contract are identical to the desktop panel.
 */
function AIPanelDisclosure({
  analysis,
  isLoading,
  error,
  onRetry,
}: {
  analysis?: import("@/lib/types-email").ThreadAnalysis;
  isLoading: boolean;
  error?: Error;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0" style={{ borderTop: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="email-ai-disclosure"
        className="
          group w-full flex items-center gap-1.5 min-h-[44px] px-4
          text-left type-subheadline
          transition-colors duration-200 ease-smooth
          hover:bg-[var(--hover)]
        "
        style={{ color: "var(--text)" }}
      >
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full"
          style={{ background: "var(--brand-subtle)" }}
        >
          <Sparkles size={12} style={{ color: "var(--brand)" }} aria-hidden />
        </span>
        <span className="flex-1 font-semibold">About this thread</span>
        <ChevronDown
          size={16}
          className={`transition-transform duration-200 ease-smooth ${
            open ? "rotate-180" : ""
          }`}
          style={{ color: "var(--text-muted)" }}
          aria-hidden
        />
      </button>
      {open && (
        <div id="email-ai-disclosure" className="max-h-[50dvh] overflow-y-auto">
          <EmailAIPanel
            analysis={analysis}
            isLoading={isLoading}
            error={error}
            onRetry={onRetry}
          />
        </div>
      )}
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
    <div className="droplet-shell flex flex-col items-center justify-center min-h-[60dvh] p-8 text-center">
      <span
        className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
        style={{ background: "var(--brand-subtle)" }}
      >
        <Mail size={26} style={{ color: "var(--brand)" }} aria-hidden />
      </span>
      <h1 className="type-title-3" style={{ color: "var(--text)" }}>
        No email account connected yet
      </h1>
      <p className="type-subheadline mt-2 max-w-md" style={{ color: "var(--text-muted)" }}>
        Once you connect a mailbox in Settings, Droplet will triage your inbox
        and summarise threads here, all on your Droplet.
      </p>
      <a href="/settings" className="btn sm mt-5">
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
      <div className="shrink-0 px-5 py-3" style={{ borderTop: "1px solid var(--border)" }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn gap-1.5 type-footnote"
        >
          <Sparkles size={14} style={{ color: "var(--brand)" }} aria-hidden />
          Write a reply
        </button>
      </div>
    );
  }

  return (
    <div
      className="shrink-0 px-5 py-3 space-y-2"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between">
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Reply to {to.join(", ")}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close reply"
          className="icon-btn -mr-2"
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
        className="w-full p-2.5 resize-y type-footnote placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--brand)]"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
          color: "var(--text)",
        }}
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
          className="btn primary gap-1.5 type-footnote disabled:opacity-60"
        >
          <Send size={14} aria-hidden />
          {busy ? "Saving…" : "Save draft"}
        </button>
        <span className="type-caption-2" style={{ color: "var(--text-muted)" }}>
          You&rsquo;ll confirm before it sends.
        </span>
      </div>
    </div>
  );
}
