"use client";

// Work-item detail — rendered in a right slide-over (canonical Dialog).

import { useId, useState, useEffect, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { PmIcon } from "./icons";
import {
  SafetyChip,
  PriorityFlag,
  StatePill,
  LabelTag,
  DepartmentTag,
  Avatar,
  AvatarStack,
  usePerson,
} from "./bits";
import { fmtISODate, isOverdue } from "./config";
import { useActivity, useComments, useSubIssues, useProjectLabels, pmActions } from "./usePm";
import type { PmWorkItem } from "./types";
import { escapeHtml } from "@/lib/escape-html";
import { formatRelativeTime } from "@/lib/relative-time";
import { translateError } from "@/lib/friendly-errors";

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

/** Inline Labels editor for the detail panel (WARP-948). The Labels row was
 *  read-only — it rendered the item's labels or a dead "None" with no way to
 *  add/select one. This wires the existing backend: it lists the project's
 *  labels (GET /api/pm/projects/:id/labels) and applies a full-set selection
 *  via PATCH /api/pm/work-items/:id { label_ids } (pm.updateWorkItem already
 *  does the delete-all + re-create replacement and writes an activity row).
 *
 *  Restraint-first interaction: clicking "Add label" reveals an in-place picker
 *  of the project's labels as toggle chips — no portal/positioning needed,
 *  consistent with the surface's existing chip idiom. Selecting/deselecting a
 *  chip immediately persists; the change propagates to the list via onChanged. */
function LabelsEditor({
  item,
  onChanged,
}: {
  item: PmWorkItem;
  onChanged: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const { labels: projectLabels } = useProjectLabels(item.projectId);
  const [editing, setEditing] = useState(false);
  // Optimistic local view of the selected ids so the chips flip instantly;
  // seeded from the item and reconciled to the server response on apply.
  const [selected, setSelected] = useState<string[]>(() => (item.labels ?? []).map((l) => l.id));
  const [busy, setBusy] = useState(false);

  // Re-seed when the parent pushes an updated item (e.g. after SWR revalidation).
  useEffect(() => {
    setSelected((item.labels ?? []).map((l) => l.id));
  }, [item]);

  const actions = pmActions();

  const apply = async (next: string[]) => {
    const prev = selected;
    setSelected(next); // optimistic
    setBusy(true);
    try {
      const { work_item } = await actions.updateItem(item.id, { label_ids: next });
      // Reconcile to the server's authoritative set (handles a label deleted
      // out from under us between read and write).
      if (work_item) setSelected(work_item.labels.map((l) => l.id));
      onChanged();
    } catch (e) {
      setSelected(prev); // roll back the optimistic flip
      toast(translateError(e, "projects"), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    if (busy) return;
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    void apply(next);
  };

  const labels = projectLabels ?? [];
  const chosen = projectLabels
    ? projectLabels.filter((l) => selected.includes(l.id))
    : item.labels.filter((l) => selected.includes(l.id));

  return (
    <span style={{ minWidth: 0, display: "inline-flex", flexDirection: "column", gap: 8 }}>
      <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
        {chosen.length ? (
          chosen.map((l) => <LabelTag key={l.id} label={l} />)
        ) : !editing ? (
          <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>None</span>
        ) : null}
        <button
          type="button"
          className="pm-btn ghost sm"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          aria-label={editing ? "Close label picker" : "Add label"}
        >
          <PmIcon name={editing ? "x" : "plus"} size={12} />
          {editing ? "Done" : "Add label"}
        </button>
      </span>

      {editing && (
        <span className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {labels.length ? (
            labels.map((l) => {
              const on = selected.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  className={"pm-chip" + (on ? " on" : "")}
                  onClick={() => toggle(l.id)}
                  disabled={busy}
                  aria-pressed={on}
                  aria-label={l.name}
                >
                  <span
                    className="swatch"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: l.color ?? "var(--text-4)",
                      flex: "none",
                    }}
                  />
                  {l.name}
                  {on && <PmIcon name="check" size={12} />}
                </button>
              );
            })
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-4)" }}>
              No labels in this project yet.
            </span>
          )}
        </span>
      )}
    </span>
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
          <LabelsEditor item={item} onChanged={onChanged} />
        </PropRow>
        {/* ADR-045 §5.3 — the RESOLVED department, with where it came from.
            Read-only in this slice: the picker is a write, and a write on this
            panel owes the §8 safety-chip contract a design pass this slice has
            not had. The API and the LLM tools can already set it. */}
        <PropRow icon="building" label="Department">
          {item.department ? (
            <span className="pm-row" style={{ gap: 7 }}>
              <DepartmentTag dept={item.department} />
              <span style={{ fontSize: 12, color: "var(--text-4)" }}>
                {item.department.source === "item"
                  ? "set on this item"
                  : "from the project"}
              </span>
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--text-4)" }}>
              No department
            </span>
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
          <button className="pm-iconbtn" onClick={onClose} aria-label="Close" type="button">
            <PmIcon name="x" size={16} />
          </button>
        </div>
        <DetailBody item={item} onChanged={onChanged} />
      </div>
    </Dialog>
  );
}
