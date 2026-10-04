"use client";

// Attachments on a work item (WARP-1505): the drawer's Attachments section, the
// upload queue it shares with the comment composer, and the small pieces both
// use — file drop, paste and the file picker.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
  type JSX,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { PmIcon } from "./icons";
import { Skel, usePerson } from "./bits";
import { PmRequestError, pmActions, uploadAttachment, type useAttachments } from "./usePm";
import { canWrite, type PmAttachment } from "./types";

const fileUrl = (id: string, inline = false) => `/api/pm/attachments/${id}${inline ? "?inline=1" : ""}`;

/** 512 B · 2 KB · 1.2 MB · 25 MB (a whole number drops its ".0"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${parseFloat((bytes / 1024 / 1024).toFixed(1))} MB`;
}

const PASTED_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A screenshot pasted from the clipboard can arrive with no name. */
function nameIfBlank(file: File): File {
  if (file.name) return file;
  const ext = PASTED_EXT[file.type];
  return new File([file], ext ? `image.${ext}` : "file", { type: file.type });
}

/** Files on the clipboard — empty for a plain-text paste, which must stay untouched. */
export function pastedFiles(e: ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.files ?? [], nameIfBlank);
}

const hasFiles = (dt: DataTransfer | null | undefined) => Array.from(dt?.types ?? []).includes("Files");

// ── Upload queue ────────────────────────────────────────────────────────────

/** One upload in flight, or one that failed and waits to be dismissed. */
export interface UploadRow {
  id: string;
  name: string;
  /** Set when the file is going to a comment rather than to the item. */
  commentId?: string;
  /** 0..100 */
  pct: number;
  /** The sentence to show once the upload has failed. */
  error?: string;
}

const MAX_PARALLEL = 3;
let nextRow = 0;

const tooLarge = (name: string, limit?: number) =>
  limit ? `${name} is larger than ${formatSize(limit)}.` : `${name} is too large to attach.`;

/** What a failed upload says. Too-large and blocked files name themselves and the
 *  reason; everything else goes through the shared translator, never a raw code. */
function uploadErrorMessage(name: string, e: unknown, listedLimit?: number): string {
  const err = e instanceof PmRequestError ? e : undefined;
  if (err?.status === 413) return tooLarge(name, err.maxBytes ?? listedLimit);
  if (err?.code === "attachment_type_blocked") return `${name} can't be added — executable files aren't allowed.`;
  if (err?.code === "attachment_type_mismatch") return `${name} doesn't look like the file type its name says.`;
  return translateError(e, "projects");
}

/** The upload queue for one work item, shared by the Attachments section, the
 *  comment composer and the drawer-wide drop target. At most MAX_PARALLEL files
 *  are in flight at once, across all of them. `onUploaded` runs after each file
 *  lands (the drawer refreshes the list and the activity feed there). */
export function useAttachmentUploads(
  itemId: string,
  { maxBytes, onUploaded }: { maxBytes?: number; onUploaded: () => Promise<unknown> },
) {
  const [queue, setQueue] = useState<UploadRow[]>([]);
  const stop = useRef<AbortController | null>(null);
  const waiting = useRef<Array<() => Promise<void>>>([]);
  const running = useRef(0);

  // Closing the drawer cancels what is still in flight. The controller is made
  // in the effect, not at first render: StrictMode runs mount, cleanup, mount,
  // and a controller aborted by that first cleanup would cancel every upload.
  useEffect(() => {
    const ctl = new AbortController();
    stop.current = ctl;
    return () => ctl.abort();
  }, []);

  const patch = (id: string, change: Partial<UploadRow>) =>
    setQueue((q) => q.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const dismiss = (id: string) => setQueue((q) => q.filter((r) => r.id !== id));

  const pump = () => {
    while (running.current < MAX_PARALLEL && waiting.current.length > 0) {
      running.current += 1;
      void waiting.current
        .shift()!()
        .finally(() => {
          running.current -= 1;
          pump();
        });
    }
  };

  /** Resolves true when the file landed. */
  const send = (row: UploadRow, file: File): Promise<boolean> =>
    new Promise((resolve) => {
      waiting.current.push(async () => {
        const signal = stop.current?.signal;
        let last = -1;
        try {
          await uploadAttachment(itemId, file, {
            commentId: row.commentId,
            signal,
            onProgress: (fraction) => {
              const pct = Math.round(fraction * 100);
              if (pct === last) return;
              last = pct;
              patch(row.id, { pct });
            },
          });
        } catch (e) {
          if (signal?.aborted) dismiss(row.id);
          else patch(row.id, { error: uploadErrorMessage(row.name, e, maxBytes) });
          resolve(false);
          return;
        }
        await onUploaded();
        dismiss(row.id);
        resolve(true);
      });
      pump();
    });

  /** Queue files for the item, or for one of its comments. Resolves with how
   *  many did not land, once every file has settled. */
  const addFiles = (files: Iterable<File>, { commentId }: { commentId?: string } = {}): Promise<number> => {
    const jobs = Array.from(files, nameIfBlank).map((file) => {
      const row: UploadRow = { id: `up-${++nextRow}`, name: file.name, commentId, pct: 0 };
      // The limit is known and the file is plainly over it: say so now rather
      // than send megabytes to be refused.
      if (maxBytes && file.size > maxBytes) row.error = tooLarge(file.name, maxBytes);
      return { row, file };
    });
    setQueue((q) => [...q, ...jobs.map((j) => j.row)]);
    return Promise.all(jobs.map((j) => (j.row.error ? Promise.resolve(false) : send(j.row, j.file)))).then(
      (landed) => landed.filter((ok) => !ok).length,
    );
  };

  return { queue, addFiles, dismiss };
}

// ── Drop, paste, pick ───────────────────────────────────────────────────────

/** Drag-and-drop for files. `over` is true while a file drag is inside, counted
 *  with a depth counter because dragenter/dragleave also fire for every child.
 *  A drag that carries no files is ignored. A `nested` target takes its events
 *  for itself (stopPropagation) so a drop on it does not also reach the target
 *  around it. */
export function useFileDrop(onFiles: (files: File[]) => void, { nested = false } = {}) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  // preventDefault on every file drag marks this a valid target and stops the
  // browser from opening the dropped file in place of the page.
  const claim = (e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return false;
    e.preventDefault();
    if (nested) e.stopPropagation();
    return true;
  };
  const dropProps = {
    onDragEnter: (e: ReactDragEvent) => {
      if (!claim(e)) return;
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: ReactDragEvent) => {
      if (claim(e)) e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: ReactDragEvent) => {
      if (!claim(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: ReactDragEvent) => {
      if (!claim(e)) return;
      depth.current = 0;
      setOver(false);
      onFiles(Array.from(e.dataTransfer.files));
    },
  };
  return { over, dropProps };
}

/** A file dropped where nothing takes it makes the browser open the file and
 *  leave the page. While the drawer is up, swallow those drops window-wide —
 *  the dimmed area beside the panel included. */
export function usePreventStrayFileDrops() {
  useEffect(() => {
    const stray = (e: DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener("dragover", stray);
    window.addEventListener("drop", stray);
    return () => {
      window.removeEventListener("dragover", stray);
      window.removeEventListener("drop", stray);
    };
  }, []);
}

/** A hidden multi-file input, and the function that opens it. */
export function useFilePicker(onFiles: (files: File[]) => void, label: string) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      aria-label={label}
      onChange={(e) => {
        onFiles(Array.from(e.target.files ?? []));
        e.target.value = ""; // so choosing the same file again still fires change
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/** Rows for uploads in flight or failed, plus one polite live region for the
 *  whole queue: a progress bar per file is silent, and announcing every percent
 *  would be noise. */
export function UploadRows({
  rows,
  onDismiss,
}: {
  rows: UploadRow[];
  onDismiss: (id: string) => void;
}): JSX.Element {
  const failed = rows.filter((r) => r.error);
  const working = rows.length - failed.length;
  const status = failed.length
    ? failed.map((r) => r.error).join(" ")
    : working
      ? `Uploading ${working} ${working === 1 ? "file" : "files"}…`
      : "";
  return (
    <>
      <div className="pm-sr" role="status" aria-live="polite">
        {status}
      </div>
      {rows.length > 0 && (
        <ul className="pm-attlist" aria-label="Uploads">
          {rows.map((r) => (
            <li key={r.id} className={"pm-att" + (r.error ? " err" : "")}>
              <span className="pm-att-ico">
                <PmIcon name={r.error ? "alert" : "doc"} size={16} style={r.error ? { color: "var(--err)" } : undefined} />
              </span>
              <div className="pm-att-body">
                <span className="pm-att-name" id={`${r.id}-name`} title={r.name}>
                  {r.name}
                </span>
                {r.error ? (
                  <div className="pm-att-meta">{r.error}</div>
                ) : (
                  <div
                    className="pm-bar"
                    role="progressbar"
                    aria-label={`Uploading ${r.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={r.pct}
                  >
                    <span style={{ width: `${r.pct}%` }} />
                  </div>
                )}
              </div>
              {r.error ? (
                <button
                  type="button"
                  className="pm-btn ghost sm"
                  aria-describedby={`${r.id}-name`}
                  onClick={() => onDismiss(r.id)}
                >
                  Dismiss
                </button>
              ) : (
                <span className="pm-att-pct" aria-hidden="true">
                  {r.pct}%
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Files chosen for a comment that has not been sent yet. */
export function StagedFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (index: number) => void;
}): JSX.Element | null {
  if (!files.length) return null;
  return (
    <ul className="pm-attlist pm-fchips" aria-label="Files to attach" style={{ marginTop: 8 }}>
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`}>
          <span className="pm-fchip">
            <PmIcon name="doc" size={14} />
            <span className="nm">{f.name}</span>
            <span className="sz">{formatSize(f.size)}</span>
            <button type="button" className="rm" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)}>
              <PmIcon name="x" size={12} />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The files a comment carries, under its text. */
export function CommentAttachments({ files }: { files: PmAttachment[] }): JSX.Element | null {
  if (!files.length) return null;
  return (
    <ul className="pm-attlist pm-fchips" aria-label="Files attached to this comment" style={{ marginTop: 8 }}>
      {files.map((a) => (
        <li key={a.id}>
          {a.previewable ? (
            <a className="pm-att-pic" href={fileUrl(a.id)} download aria-label={a.fileName} title={a.fileName}>
              <img className="pm-att-thumb lg" src={fileUrl(a.id, true)} alt="" loading="lazy" />
            </a>
          ) : (
            <a className="pm-fchip" href={fileUrl(a.id)} download title={a.fileName}>
              <PmIcon name="doc" size={14} />
              <span className="nm">{a.fileName}</span>
              <span className="sz">{formatSize(a.sizeBytes)}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function FileRow({ a, onRemove }: { a: PmAttachment; onRemove?: (button: HTMLElement) => void }): JSX.Element {
  const person = usePerson();
  return (
    <li className="pm-att">
      {/* The name is the link; this one only enlarges the target for a mouse. */}
      <a className="pm-att-pic" href={fileUrl(a.id)} download tabIndex={-1} aria-hidden="true">
        {a.previewable ? (
          <img className="pm-att-thumb" src={fileUrl(a.id, true)} alt="" loading="lazy" />
        ) : (
          <span className="pm-att-ico">
            <PmIcon name="doc" size={16} />
          </span>
        )}
      </a>
      <div className="pm-att-body">
        <a className="pm-att-name" href={fileUrl(a.id)} download title={a.fileName}>
          {a.fileName}
        </a>
        <div className="pm-att-meta">
          {formatSize(a.sizeBytes)} · {a.uploadedById ? person(a.uploadedById).name : "Droplet AI"} ·{" "}
          {formatRelativeTime(a.createdAt)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          className="pm-iconbtn"
          aria-label={`Remove ${a.fileName}`}
          onClick={(e) => onRemove(e.currentTarget)}
        >
          <PmIcon name="trash" size={15} />
        </button>
      )}
    </li>
  );
}

// ── The section ─────────────────────────────────────────────────────────────

export function AttachmentsSection({
  att,
  uploads,
  onChanged,
}: {
  att: ReturnType<typeof useAttachments>;
  uploads: ReturnType<typeof useAttachmentUploads>;
  /** Refresh whatever a change touches: the list and the activity feed. */
  onChanged: () => Promise<unknown>;
}): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const headId = useId();
  const hintId = useId();
  const zone = useRef<HTMLDivElement>(null);
  // Where focus goes when the confirm closes: the Remove button that opened it,
  // or the add area once that row is gone.
  const restoreTo = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<PmAttachment | null>(null);
  const picker = useFilePicker((files) => void uploads.addFiles(files), "Choose files to attach");

  const writer = canWrite(user?.role);
  const admin = user?.role === "owner" || user?.role === "admin";
  const canRemove = (a: PmAttachment) => writer && (admin || a.uploadedById === user?.id);

  const files = att.attachments ?? [];
  const loading = att.isLoading && !att.attachments;
  // A failed refresh keeps the list it already has; only a first load that
  // failed has nothing to show.
  const failed = Boolean(att.error) && !att.attachments;

  const remove = async () => {
    if (!removing) return;
    try {
      await pmActions().deleteAttachment(removing.id);
    } catch (e) {
      toast(translateError(e, "projects"), "error");
      throw e; // ConfirmDialog stays open, so it can be retried
    }
    await onChanged();
    restoreTo.current = zone.current;
  };

  return (
    <div role="group" aria-labelledby={headId}>
      <div className="pm-sect" id={headId} style={{ marginBottom: 6 }}>
        Attachments <span className="sx">{files.length}</span>
      </div>

      {loading ? (
        <div aria-busy="true">
          <span className="pm-sr">Loading attachments…</span>
          {[0, 1].map((i) => (
            <div key={i} className="pm-att">
              <Skel w={36} h={36} r={8} style={{ flex: "none" }} />
              <div className="pm-att-body">
                <Skel w="55%" h={12} />
                <Skel w="35%" h={10} style={{ marginTop: 7 }} />
              </div>
            </div>
          ))}
        </div>
      ) : failed ? (
        <div className="pm-row" style={{ gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>Couldn&apos;t load attachments.</span>
          <button type="button" className="pm-btn ghost sm" onClick={() => void att.mutate()}>
            Try again
          </button>
        </div>
      ) : files.length ? (
        <ul className="pm-attlist">
          {files.map((a) => (
            <FileRow
              key={a.id}
              a={a}
              onRemove={
                canRemove(a)
                  ? (button) => {
                      restoreTo.current = button;
                      setRemoving(a);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-4)" }}>No attachments yet.</div>
      )}

      <UploadRows rows={uploads.queue.filter((r) => !r.commentId)} onDismiss={uploads.dismiss} />

      {writer && (
        <div
          ref={zone}
          className="pm-att-zone"
          role="group"
          aria-label="Add attachments"
          aria-describedby={hintId}
          tabIndex={0}
          onPaste={(e) => {
            const pasted = pastedFiles(e);
            if (!pasted.length) return;
            e.preventDefault();
            void uploads.addFiles(pasted);
          }}
        >
          <button type="button" className="pm-btn sm" onClick={picker.open}>
            <PmIcon name="plus" size={12} />
            Add files
          </button>
          <span className="pm-att-hint" id={hintId}>
            Drop files here, paste an image, or choose files.
            {att.maxBytes ? ` Up to ${formatSize(att.maxBytes)} each.` : ""}
          </span>
          {picker.input}
        </div>
      )}

      {/* The confirm portals out of the drawer, but React still bubbles its
          keydowns to the drawer's focus trap, which would pull every Tab back
          into the drawer and strand the confirm's buttons. Only Tab is stopped:
          Escape closes dialogs from a window listener that must still see it. */}
      <span style={{ display: "contents" }} onKeyDown={(e) => e.key === "Tab" && e.stopPropagation()}>
        <ConfirmDialog
          open={removing !== null}
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
          triggerRef={restoreTo}
          title="Remove this file?"
          description="It will be deleted from this item and can't be recovered."
          confirmLabel="Remove"
        />
      </span>
    </div>
  );
}
