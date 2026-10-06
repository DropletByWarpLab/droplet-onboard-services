"use client";

// A ticket's conversation, oldest first: replies, internal notes and the quiet
// one-line history between them. A reply and a note are told apart by surface,
// edge and WORDS — "Internal note — not sent" — never by colour alone.

import type { JSX } from "react";
import { PmIcon } from "@/components/projects/icons";
import { EmptyBlock, Skel } from "@/components/projects/bits";
import { relativeTime } from "./support-config";
import type { CommentEntry, ConversationEntry } from "./types";

type ActivityEntry = Extract<ConversationEntry, { type: "activity" }>;

/** One plain sentence per history verb. Unknown verbs read as a generic edit
 *  rather than being hidden — the history never silently drops a change. */
export function activitySentence(a: ActivityEntry): string {
  const who = a.actor?.displayName ?? "Droplet";
  const { from, to } = a;
  switch (a.verb) {
    case "created":
      return `${who} opened this ticket`;
    case "state_changed":
      return `${who} changed the status${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`;
    case "assigned":
      return `${who} assigned this to ${to ?? "someone"}`;
    case "unassigned":
      return `${who} took ${from ?? "someone"} off this ticket`;
    case "title_changed":
      return `${who} changed the subject${to ? ` to “${to}”` : ""}`;
    case "description_changed":
      return `${who} edited the details`;
    case "label_added":
      return `${who} added the label ${to ?? ""}`.trim();
    case "label_removed":
      return `${who} removed the label ${from ?? ""}`.trim();
    case "relation_added":
      return `${who} linked this to ${to ?? "a work item"}`;
    case "relation_removed":
      return `${who} removed a link to ${from ?? "a work item"}`;
    case "updated":
      if (a.field === "priority") return `${who} changed the priority${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`;
      if (a.field === "department") return to ? `${who} moved this to ${to}` : `${who} cleared the department`;
      if (a.field === "company") return to ? `${who} filed this under ${to}` : `${who} cleared the customer`;
      return `${who} updated this ticket`;
    default:
      return `${who} updated this ticket`;
  }
}

const KIND_LABEL: Record<CommentEntry["authorKind"], string | null> = {
  USER: null,
  CONTACT: "Customer",
  SYSTEM: "System",
  AUTOMATION: "Automation",
};

function Comment({ entry, onRetryDelivery }: { entry: CommentEntry; onRetryDelivery?: (id: string) => void }): JSX.Element {
  const note = entry.visibility === "INTERNAL";
  const kind = KIND_LABEL[entry.authorKind];
  return (
    <li className={"sp-entry " + (note ? "note" : "reply")} aria-label={note ? "Internal note" : "Reply"}>
      <div className="sp-entry-h">
        <strong>{entry.author?.displayName ?? kind ?? "Droplet"}</strong>
        {kind && entry.author && <span>· {kind}</span>}
        <span className="pm-mono" title={new Date(entry.createdAt).toLocaleString()}>
          {relativeTime(entry.createdAt)}
        </span>
        <span className="sp-visibility" style={{ marginLeft: "auto" }}>
          <PmIcon name={note ? "pencil" : "send"} size={12} />
          {note ? "Internal note — not sent" : "Reply"}
        </span>
        {!note && entry.deliveryStatus !== "NONE" && (
          <span className="sp-visibility" aria-label={`Email ${entry.deliveryStatus.toLowerCase()}`}>
            {entry.deliveryStatus === "PENDING" ? "Email queued" : entry.deliveryStatus === "SENT" ? "Email sent" : `Email failed${entry.deliveryFailure ? `: ${entry.deliveryFailure.toLowerCase().replaceAll("_", " ")}` : ""}`}
          </span>
        )}
        {!note && entry.deliveryStatus === "FAILED" && onRetryDelivery && (
          <button className="pm-btn ghost" type="button" onClick={() => onRetryDelivery(entry.id)}>Retry email</button>
        )}
      </div>
      {/* Server-sanitized against the strict PM allowlist at the write boundary
          (support service `cleanHtml`), exactly as the Projects drawer renders
          its comments. */}
      <div className="pm-prose" dangerouslySetInnerHTML={{ __html: entry.html }} />
    </li>
  );
}

export function Conversation({
  entries,
  truncated,
  loading,
  error,
  onRetry,
  onRetryDelivery,
}: {
  entries: ConversationEntry[] | undefined;
  truncated: boolean;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onRetryDelivery?: (id: string) => void;
}): JSX.Element {
  if (loading && !entries) {
    return (
      <div className="sp-convo" aria-busy="true" aria-label="Loading the conversation">
        {[0, 1, 2].map((i) => (
          <div key={i} className="sp-entry">
            <Skel w="35%" h={11} />
            <Skel w="90%" h={11} />
          </div>
        ))}
      </div>
    );
  }
  if (error && !entries) {
    return (
      <div className="pm-surface">
        <EmptyBlock
          icon="msg"
          tone="error"
          heading="Couldn't load the conversation."
          body="Check the appliance connection and try again."
          cta={<button className="pm-btn ghost" type="button" onClick={onRetry}>Try again</button>}
        />
      </div>
    );
  }
  const list = entries ?? [];
  if (list.length === 0) {
    return (
      <div className="pm-surface">
        <EmptyBlock icon="msg" heading="No messages yet." body="Replies and internal notes appear here." />
      </div>
    );
  }
  return (
    <>
      {truncated && (
        <p className="sp-hint" role="status" style={{ margin: 0 }}>
          This ticket has a long history — only the most recent entries are shown.
        </p>
      )}
      <ol className="sp-convo" aria-label="Conversation">
        {list.map((e) =>
          e.type === "comment" ? (
            <Comment key={e.id} entry={e} onRetryDelivery={onRetryDelivery} />
          ) : (
            <li key={e.id} className="sp-activity">
              <span>{activitySentence(e)}</span>
              <span className="pm-mono" title={new Date(e.createdAt).toLocaleString()}>
                {relativeTime(e.createdAt)}
              </span>
            </li>
          ),
        )}
      </ol>
    </>
  );
}
