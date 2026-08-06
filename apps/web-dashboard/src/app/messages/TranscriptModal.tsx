"use client";

/**
 * WARP-1683 — read-only transcript viewer for a forwarded AI chat. Fetches
 * the message's IMMUTABLE snapshot (participant-gated server-side) and
 * renders role-labeled bubbles: the person's turns right-accented, the
 * assistant's left-neutral — the same left/right grammar as /chat, so a
 * forwarded conversation reads instantly.
 */

import useSWR from "swr";
import { Sparkles } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import {
  fetchTeamChatTranscript,
  type TeamChatMessage,
  type TeamChatTranscript,
} from "@/lib/api";

export function TranscriptModal({
  message,
  onClose,
}: {
  /** The ai_chat_share message whose transcript is open, or null. */
  message: TeamChatMessage | null;
  onClose: () => void;
}) {
  const { data, error, isLoading } = useSWR<TeamChatTranscript>(
    message ? `/api/team-chat/messages/${message.id}/transcript` : null,
    () => fetchTeamChatTranscript((message as TeamChatMessage).id),
    { shouldRetryOnError: false },
  );

  return (
    <Dialog
      open={message !== null}
      onClose={onClose}
      labelledBy="transcript-title"
      maxWidth="lg"
    >
      <div>
        <div className="flex items-center gap-2">
          <Sparkles
            size={16}
            style={{ color: "var(--brand)" }}
            aria-hidden="true"
          />
          <h2 id="transcript-title" className="mx-dlg-title truncate">
            {data?.title ?? "AI conversation"}
          </h2>
        </div>
        <p className="mx-dlg-sub">Shared snapshot — read-only.</p>

        <div className="mt-3 max-h-[60vh] overflow-y-auto flex flex-col gap-2 pr-1">
          {isLoading && <p className="mx-quiet">Loading transcript…</p>}
          {error != null && (
            <p className="mx-error">This transcript isn&apos;t available.</p>
          )}
          {data && data.messages.length === 0 && (
            <p className="mx-quiet">This conversation had no messages.</p>
          )}
          {data?.messages.map((m, i) => {
            const isUser = m.role === "user";
            // The transcript's "user" turns belong to whoever OWNED the AI
            // chat — the message's sender. Naming them (not "Them") stays
            // correct when the sharer reopens their own forward.
            const userLabel = message?.senderDisplayName ?? "Member";
            return (
              <div
                key={`${m.createdAt}-${i}`}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
              >
                <span className="mx-sender">
                  {isUser ? userLabel : "Assistant"}
                </span>
                <div
                  className={`mx-bubble ${isUser ? "is-mine" : "is-theirs"} whitespace-pre-wrap break-words`}
                >
                  {m.content}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn">
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
