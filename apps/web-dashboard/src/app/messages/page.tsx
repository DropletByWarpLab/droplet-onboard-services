"use client";

/**
 * /messages — Team chat v1 (WARP-1683): member-to-member DMs + small
 * groups, with two forward types (a Files document, an AI-chat transcript).
 *
 * Layout: two-pane on lg+ (thread list left, conversation right), stacked
 * on mobile (list OR conversation with a back affordance) — one design
 * system across viewports (team rule).
 *
 * Freshness is polling for v1 (no ws-bridge wiring): the open thread every
 * ~5s, the list + unread badge every ~20s, plus SWR's focus revalidation —
 * see lib/hooks/useTeamChat.ts. Sends await the server then mutate the
 * affected SWR keys (no optimistic insert — the poll cadence keeps the gap
 * short and there is no rollback state to get wrong).
 *
 * Painted by messages-indigo.css (WARP-1783) — the surface reads the
 * `.droplet-shell` indigo tokens ShellPage already puts in scope, matching
 * /chat, / and /voice. It used to use the legacy globals.css surface ramp.
 */

import { useCallback, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { useSWRConfig } from "swr";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import {
  TEAM_CHAT_THREADS_KEY,
  TEAM_CHAT_UNREAD_KEY,
  teamChatMessagesKey,
  useTeamChatThreads,
} from "@/lib/hooks/useTeamChat";
import { ThreadList } from "./ThreadList";
import { ConversationPane } from "./ConversationPane";
import { NewThreadDialog } from "./NewThreadDialog";
import "./messages-indigo.css";

const SUB =
  "Direct and group messages between members of this Droplet — and a place to hand a file or an AI conversation to a colleague. Everything stays on the box.";

export default function MessagesPage() {
  const { user } = useAuth();
  const { threads, isLoading, error: threadsError } = useTeamChatThreads();
  const { mutate } = useSWRConfig();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const selectedThread =
    threads?.find((t) => t.id === selectedThreadId) ?? null;

  // A thread created (or deduped) from the compose dialog becomes the
  // selection; the list refetch fills in its row.
  const handleCreated = useCallback(
    (threadId: string) => {
      setComposeOpen(false);
      setSelectedThreadId(threadId);
      void mutate(TEAM_CHAT_THREADS_KEY);
      void mutate(teamChatMessagesKey(threadId));
    },
    [mutate],
  );

  const handleActivity = useCallback(
    (threadId: string) => {
      void mutate(TEAM_CHAT_THREADS_KEY);
      void mutate(TEAM_CHAT_UNREAD_KEY);
      void mutate(teamChatMessagesKey(threadId));
    },
    [mutate],
  );

  return (
    <ShellPage
      icon={<MessagesSquare size={15} />}
      label="Messages"
      title="Messages"
      sub={SUB}
    >
      <div
        className="
          mx-shell
          h-[calc(100dvh-260px)] min-h-[420px]
          grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]
        "
      >
        {/* Thread list — always on lg+; on mobile only while nothing is open. */}
        <div
          className={`
            mx-rail min-h-0
            ${selectedThreadId ? "hidden lg:flex" : "flex"} flex-col
          `}
        >
          <ThreadList
            threads={threads}
            isLoading={isLoading}
            loadFailed={threadsError !== undefined && threads === undefined}
            meId={user?.id ?? ""}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onCompose={() => setComposeOpen(true)}
          />
        </div>

        {/* Conversation — on mobile only while a thread is open. */}
        <div
          className={`
            min-h-0 ${selectedThreadId ? "flex" : "hidden lg:flex"} flex-col
          `}
        >
          <ConversationPane
            thread={selectedThread}
            meId={user?.id ?? ""}
            onBack={() => setSelectedThreadId(null)}
            onActivity={handleActivity}
          />
        </div>
      </div>

      <NewThreadDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        meId={user?.id ?? ""}
        onCreated={handleCreated}
      />
    </ShellPage>
  );
}
