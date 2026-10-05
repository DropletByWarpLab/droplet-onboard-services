"use client";

// Work-item detail — rendered in a right slide-over (canonical Dialog).

import { useId, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { PmIcon } from "./icons";
import {
  SafetyChip,
  PriorityFlag,
  StatePill,
  Avatar,
  AvatarStack,
  usePerson,
} from "./bits";
import { useActivity, useComments, useSubIssues, pmActions } from "./usePm";
import { editActions } from "./useEditing";
import { CycleField, ModulesField } from "./planning-pickers";
import { PropRow } from "./detail/PropRow";
import type { PmWorkItem } from "./types";
import { TimeSection } from "./time/TimeSection";
import { escapeHtml } from "@/lib/escape-html";
import { formatRelativeTime } from "@/lib/relative-time";
import { TitleEditor } from "./detail/TitleEditor";
import { DescriptionEditor } from "./detail/DescriptionEditor";
import { PropertiesPanel } from "./detail/PropertiesPanel";
import { RelationsPanel } from "./detail/RelationsPanel";
import { ItemMenu } from "./detail/ItemMenu";
import { useItemSave } from "./detail/useItemSave";

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
      if (field === "priority") return "changed the priority";
      // ADR-045 §5.3 — re-routing work to another department is a decision
      // about who owns it, and "updated the item" hides exactly that.
      if (field === "department") return "changed the department";
      return "updated the item";
    default:
      return verb.replace(/_/g, " ");
  }
}

function Composer({ itemId, onSent }: { itemId: string; onSent: () => void }): JSX.Element {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = pmActions();
  const { toast } = useToast();
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await actions.addComment(itemId, `<p>${escapeHtml(body)}</p>`);
      setText("");
      onSent();
    } catch (e) {
      // DASH-002: a failed comment POST used to surface as an unhandled
      // rejection — the button just reset with no feedback. Toast like the
      // sibling composers (NewItemModal / LabelsEditor).
      toast(e instanceof Error ? e.message : "Couldn't send the comment", "error");
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

function DetailBody({
  item: serverItem,
  onChanged,
  readOnly,
}: {
  item: PmWorkItem;
  onChanged: () => void;
  readOnly: boolean;
}): JSX.Element {
  const person = usePerson();
  // WARP-3520 -- every editor writes through this one optimistic layer; `item` is
  // the server's copy with in-flight and just-saved edits laid over it.
  const edit = useItemSave(serverItem, onChanged);
  const item = edit.view;
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
          {item.isArchived && <span className="badge muted">Archived</span>}
          <span style={{ marginLeft: "auto" }}>
            <SafetyChip tier="read" />
          </span>
        </div>
        <TitleEditor
          name={item.name}
          readOnly={readOnly}
          onSave={(name) =>
            edit.save("title", "Title", { name }, () => editActions().patchItem(item.id, { name }))
          }
        />
      </div>

      <DescriptionEditor
        html={item.descriptionHtml}
        readOnly={readOnly}
        onSave={(html) =>
          edit.save("description", "Description", { descriptionHtml: html }, () =>
            editActions().patchItem(item.id, { description_html: html }),
          )
        }
      />

      <PropertiesPanel edit={edit} readOnly={readOnly} onChanged={onChanged}>
        <PropRow icon="target" label="Cycle">
          <CycleField item={item} readOnly={readOnly} onChanged={onChanged} />
        </PropRow>
        <PropRow icon="layers" label="Modules">
          <ModulesField item={item} readOnly={readOnly} onChanged={onChanged} />
        </PropRow>
      </PropertiesPanel>

      <RelationsPanel item={item} readOnly={readOnly} onChanged={() => void mutateActivity()} />

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

      <TimeSection item={item} />

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
  readOnly = false,
  canDelete = false,
}: {
  item: PmWorkItem;
  onClose: () => void;
  onChanged: () => void;
  /** WARP-3520 — hide every editor (members, viewers, guests read only).
   *  Default: editable, so existing callers and fixtures keep their editors;
   *  the Projects page always passes the real value. */
  readOnly?: boolean;
  /** WARP-3520 — owner/admin: may hard-delete the item (the API refuses
   *  everyone else). Default: false. */
  canDelete?: boolean;
}): JSX.Element {
  const titleId = useId();
  return (
    // `flush`: the scoped `.pm-dialog-body.is-panel` owns the inset (WARP-1153).
    <Dialog open onClose={onClose} placement="right" maxWidth="lg" labelledBy={titleId} flush>
      <div className="pm-scope pm-dialog-body is-panel">
        <div
          className="pm-row"
          style={{ justifyContent: "space-between", padding: "0 0 12px", borderBottom: "1px solid var(--border)", marginBottom: 18 }}
        >
          <span id={titleId} className="pm-mono" style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            {item.key}
          </span>
          <span className="pm-row" style={{ gap: 4 }}>
            <ItemMenu item={item} readOnly={readOnly} canDelete={canDelete} onChanged={onChanged} onClose={onClose} />
            <button className="pm-iconbtn" onClick={onClose} aria-label="Close" type="button">
              <PmIcon name="x" size={16} />
            </button>
          </span>
        </div>
        <DetailBody item={item} onChanged={onChanged} readOnly={readOnly} />
      </div>
    </Dialog>
  );
}
