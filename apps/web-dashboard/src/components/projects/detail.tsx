"use client";

// Work-item detail — rendered in a right slide-over (canonical Dialog).

import { useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { PmIcon } from "./icons";
import {
  SafetyChip,
  PriorityFlag,
  StatePill,
  LabelTag,
  Avatar,
  AvatarStack,
  usePerson,
} from "./bits";
import { fmtISODate, isOverdue } from "./config";
import { useActivity, useComments, useSubIssues, pmActions } from "./usePm";
import type { PmWorkItem } from "./types";
import { escapeHtml } from "@/lib/escape-html";
import { formatRelativeTime } from "@/lib/relative-time";

function PropRow({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="pm-prop">
      <span className="lab">
        <PmIcon name={icon} size={14} />
        {label}
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

function SubIssueRow({ sub }: { sub: PmWorkItem }): JSX.Element {
  const done = sub.state?.group === "completed";
  return (
    <div className="pm-row" style={{ gap: 10, padding: "9px 2px", borderBottom: "1px solid var(--border)" }}>
      <span className="pm-dot" style={{ background: sub.state?.color ?? "var(--text-4)", flex: "none" }} />
      <span className="pm-mono" style={{ fontSize: 11, color: "var(--text-4)", flex: "none" }}>
        {sub.key}
      </span>
      <PriorityFlag p={sub.priority} size={12} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textDecoration: done ? "line-through" : "none",
          opacity: done ? 0.6 : 1,
        }}
      >
        {sub.name}
      </span>
      <AvatarStack ids={sub.assignees} size={20} />
    </div>
  );
}

function Comment({ authorId, html, when }: { authorId: string | null; html: string; when: string }): JSX.Element {
  const person = usePerson();
  const ai = authorId === null;
  return (
    <div className="pm-row" style={{ gap: 10, alignItems: "flex-start" }}>
      {ai ? <span className="pm-ai-av">AI</span> : <Avatar id={authorId} size={28} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pm-row" style={{ gap: 7, marginBottom: 3 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
            {ai ? "Droplet AI" : person(authorId).name}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>{when}</span>
        </div>
        {/* Comment HTML is server-sanitized against a strict allowlist at the
            write boundary (orchestrator sanitizePmHtml in addComment) — every
            persisted value, whether from the dashboard, the mobile API, or an
            MCP tool call, is clean before it ever reaches this render. */}
        <div
          className={"pm-prose" + (ai ? " pm-ai-bubble" : "")}
          style={ai ? { padding: "9px 11px", borderRadius: 10 } : undefined}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}


function humanizeActivity(verb: string, field: string | null): string {
  switch (verb) {
    case "created":
      return "created this item";
    case "state_changed":
      return "changed the state";
    case "commented":
      return "added a comment";
    case "assigned":
      return "changed assignees";
    case "updated":
      return field === "priority" ? "changed the priority" : "updated the item";
    default:
      return verb.replace(/_/g, " ");
  }
}

function Composer({ itemId, onSent }: { itemId: string; onSent: () => void }): JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = pmActions();
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await actions.addComment(itemId, `<p>${escapeHtml(body)}</p>`);
      setText("");
      onSent();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 14 }}>
      <textarea
        className="pm-input"
        placeholder="Write a comment"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        aria-label="Write a comment"
      />
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <SafetyChip tier="write" />
        <button className="pm-btn primary sm" type="button" onClick={submit} disabled={busy || !text.trim()}>
          <PmIcon name="send" size={13} />
          {busy ? "Sending…" : "Send"}
          <span className="pm-kbd" style={{ marginLeft: 2 }}>⌘↵</span>
        </button>
      </div>
    </div>
  );
}

function DetailBody({ item, onChanged }: { item: PmWorkItem; onChanged: () => void }): JSX.Element {
  const person = usePerson();
  const { subIssues } = useSubIssues(item.projectId, item.id);
  const { comments, mutate: mutateComments } = useComments(item.id);
  const { activity, mutate: mutateActivity } = useActivity(item.id);
  const subs = subIssues ?? [];
  const list = comments ?? [];
  const acts = activity ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div className="pm-row" style={{ gap: 10, marginBottom: 9 }}>
          <span className="pm-mono" style={{ fontSize: 12, color: "var(--text-4)" }}>{item.key}</span>
          {item.state && <StatePill state={item.state} />}
          <span style={{ marginLeft: "auto" }}>
            <SafetyChip tier="read" />
          </span>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.25, color: "var(--text)" }}>
          {item.name}
        </h2>
      </div>

      <div>
        <div className="pm-sect" style={{ marginBottom: 8 }}>
          Description
        </div>
        {item.descriptionHtml ? (
          // descriptionHtml is server-sanitized against a strict allowlist at the
          // write boundary (orchestrator sanitizePmHtml in createWorkItem /
          // updateWorkItem) — the stored value is always clean before render.
          <div className="pm-prose" dangerouslySetInnerHTML={{ __html: item.descriptionHtml }} />
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-4)" }}>No description yet.</div>
        )}
      </div>

      <div className="pm-surface" style={{ padding: "4px 16px" }}>
        {item.state && (
          <PropRow icon="dotCircle" label="State">
            <StatePill state={item.state} />
          </PropRow>
        )}
        <PropRow icon="signal" label="Priority">
          <PriorityFlag p={item.priority} withLabel />
        </PropRow>
        <PropRow icon="users" label="Assignees">
          {item.assignees.length ? (
            <span className="pm-row" style={{ gap: 7 }}>
              <AvatarStack ids={item.assignees} size={22} />
              <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                {item.assignees.map((a) => person(a).name).join(", ")}
              </span>
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>Unassigned</span>
          )}
        </PropRow>
        <PropRow icon="flag" label="Labels">
          {item.labels.length ? (
            <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {item.labels.map((l) => (
                <LabelTag key={l.id} label={l} />
              ))}
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>None</span>
          )}
        </PropRow>
        <PropRow icon="cal" label="Start date">
          <span className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-2)" }}>{fmtISODate(item.startDate)}</span>
        </PropRow>
        <PropRow icon="clock" label="Due date">
          <span className="pm-mono" style={{ fontSize: 12.5, color: isOverdue(item) ? "var(--warn)" : "var(--text-2)" }}>
            {fmtISODate(item.dueDate)}
          </span>
        </PropRow>
      </div>

      <div>
        <div className="pm-sect" style={{ marginBottom: 6 }}>
          Sub-issues <span className="sx">{subs.length}</span>
        </div>
        {subs.length ? (
          <div>{subs.map((s) => <SubIssueRow key={s.id} sub={s} />)}</div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-4)" }}>No sub-issues yet.</div>
        )}
      </div>

      <div>
        <div className="pm-sect" style={{ marginBottom: 12 }}>
          Comments <span className="sx">{list.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {list.length ? (
            list.map((c) => <Comment key={c.id} authorId={c.authorId} html={c.commentHtml} when={formatRelativeTime(c.createdAt)} />)
          ) : (
            <div style={{ fontSize: 13, color: "var(--text-4)" }}>No comments yet.</div>
          )}
        </div>
        <Composer
          itemId={item.id}
          onSent={() => {
            // addComment writes a PmComment AND a verb:commented PmActivity row in
            // the same transaction — revalidate both so the timeline refreshes
            // immediately instead of waiting for SWR window-focus. (ADR-026 P5)
            void mutateComments();
            void mutateActivity();
            onChanged();
          }}
        />
      </div>

      <div>
        <div className="pm-sect" style={{ marginBottom: 12 }}>
          Activity <span className="sx">{acts.length}</span>
        </div>
        {acts.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {acts.map((a) => (
              <div key={a.id} className="pm-row" style={{ gap: 9, alignItems: "flex-start" }}>
                {a.actorId ? (
                  <Avatar id={a.actorId} size={22} />
                ) : (
                  <span className="pm-ai-av" style={{ width: 22, height: 22, fontSize: 8 }}>AI</span>
                )}
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--text-2)" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {a.actorId ? person(a.actorId).name : "Droplet AI"}
                  </span>{" "}
                  {humanizeActivity(a.verb, a.field)}
                  <span style={{ color: "var(--text-4)", marginLeft: 6 }}>{formatRelativeTime(a.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-4)" }}>No activity yet.</div>
        )}
      </div>
    </div>
  );
}

export function DetailDrawer({
  item,
  onClose,
  onChanged,
}: {
  item: PmWorkItem;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const titleId = useId();
  return (
    <Dialog open onClose={onClose} placement="right" maxWidth="lg" labelledBy={titleId}>
      <div className="pm-scope pm-dialog-body is-panel">
        <div
          className="pm-row"
          style={{ justifyContent: "space-between", padding: "12px 4px 12px 0", borderBottom: "1px solid var(--border)", marginBottom: 18 }}
        >
          <span id={titleId} className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            {item.key}
          </span>
          <button className="pm-iconbtn" onClick={onClose} aria-label="Close" type="button">
            <PmIcon name="x" size={16} />
          </button>
        </div>
        <DetailBody item={item} onChanged={onChanged} />
      </div>
    </Dialog>
  );
}
