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
import { useTimeline, useAttachments, useSubIssues, useDevelopmentLinks, pmActions } from "./usePm";
import {
  AttachmentsSection,
  CommentAttachments,
  StagedFiles,
  UploadRows,
  pastedFiles,
  useAttachmentUploads,
  useFileDrop,
  useFilePicker,
  usePreventStrayFileDrops,
} from "./attachments";
import { canWrite, type PmAttachment, type PmWorkItem } from "./types";
import { CycleField, ModulesField } from "./planning-pickers";
import { ArrowUpRight, Copy } from "lucide-react";
import { editActions } from "./useEditing";
import { PropRow } from "./detail/PropRow";
import { TimeSection } from "./time/TimeSection";
import { useAuth } from "@/lib/auth";
import { ActivitySection } from "./timeline";
import { WatchControl } from "./watchers";
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

function DetailBody({
  item: serverItem,
  onChanged,
  readOnly,
}: {
  item: PmWorkItem;
  onChanged: () => void;
  readOnly: boolean;
}): JSX.Element {
  // WARP-3520 -- every editor writes through this one optimistic layer; `item` is
  // the server's copy with in-flight and just-saved edits laid over it.
  const edit = useItemSave(serverItem, onChanged);
  const item = edit.view;
  const { subIssues } = useSubIssues(item.projectId, item.id);
  const { mutate: mutateActivity } = useTimeline(item.id);
  const { links: developmentLinks, isLoading: developmentLoading, error: developmentError } = useDevelopmentLinks(item.id);
  const { toast } = useToast();
  const { user } = useAuth();
  const writer = !readOnly && canWrite(user?.role);
  const att = useAttachments(item.id);
  // A file landing or going changes the list and writes an activity row.
  const refreshFiles = () => Promise.all([att.mutate(), mutateActivity()]);
  const uploads = useAttachmentUploads(item.id, { maxBytes: att.maxBytes, onUploaded: refreshFiles });
  // The whole body takes drops for the item (writers only; the composer takes
  // its own for the comment).
  const drop = useFileDrop((dropped) => void uploads.addFiles(dropped));
  usePreventStrayFileDrops();
  const subs = subIssues ?? [];

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 20, position: "relative" }}
      {...(writer ? drop.dropProps : {})}
    >
      {writer && drop.over && (
        <div className="pm-dropveil" aria-hidden="true">
          <span>Drop files to attach</span>
        </div>
      )}
      <div>
        <div className="pm-row" style={{ gap: 10, marginBottom: 9 }}>
          <span className="pm-mono" style={{ fontSize: 12, color: "var(--text-4)" }}>{item.key}</span>
          {item.state && <StatePill state={item.state} />}
          {item.isArchived && <span className="badge muted">Archived</span>}
          <span style={{ marginLeft: "auto" }} className="pm-row">
            <WatchControl itemId={item.id} viewerId={user?.id} role={user?.role} assignees={item.assignees} />
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

      <section aria-labelledby="pm-development-heading">
        <div className="pm-sect pm-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span id="pm-development-heading">Development</span>
          <button
            type="button"
            className="pm-btn ghost sm"
            aria-label="Copy development branch name"
            onClick={() => {
              const [identifier, sequence] = item.key.split("-");
              const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
              const name = `${identifier.toLowerCase()}-${sequence}${slug ? `-${slug}` : ""}`;
              void navigator.clipboard.writeText(name).then(() => toast("Branch name copied", "success"), () => toast("Couldn't copy the branch name", "error"));
            }}
          >
            <Copy size={13} aria-hidden /> Copy branch
          </button>
        </div>
        {developmentLoading ? (
          <div className="type-footnote" role="status">Loading development links…</div>
        ) : developmentError ? (
          <div className="type-footnote" role="status">Development links are temporarily unavailable.</div>
        ) : developmentLinks?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {developmentLinks.map((link) => (
              <a key={link.id} href={link.url} target="_blank" rel="noopener noreferrer" className="pm-surface"
                style={{ padding: "9px 11px", display: "flex", alignItems: "center", gap: 8, color: "var(--text)", textDecoration: "none" }}>
                <span className="pm-mono" style={{ color: "var(--text-4)", fontSize: 10.5, flex: "none" }}>{link.kind === "PULL_REQUEST" ? `PR ${link.number ?? ""}` : link.kind === "COMMIT" ? "Commit" : "Branch"}</span>
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>{link.title}</span>
                <span className="pm-chip" style={{ flex: "none", fontSize: 10 }}>{link.state.toLowerCase()}</span>
                <ArrowUpRight size={13} aria-hidden style={{ color: "var(--text-4)", flex: "none" }} />
              </a>
            ))}
          </div>
        ) : (
          <div className="type-footnote">No linked pull requests, commits, or branches yet.</div>
        )}
      </section>

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

      <AttachmentsSection att={att} uploads={uploads} onChanged={refreshFiles} readOnly={readOnly} />
      {/* WARP-3519 — comments and history as one thread: edit/delete, reactions,
          @mentions, watchers. The server writes a `commented` activity row in the
          same transaction as the comment; the section re-reads the merged
          timeline itself, and `onChanged` refreshes the board's comment counts. */}
      <ActivitySection itemId={item.id} viewerId={user?.id} role={user?.role} onChanged={() => { void att.mutate(); onChanged(); }} attachments={att.attachments ?? []} uploads={uploads} canAttach={writer} />
      <TimeSection item={item} />
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
