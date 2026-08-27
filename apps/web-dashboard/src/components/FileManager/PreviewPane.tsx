"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { X, Download, FileText, Pencil } from "lucide-react";
import { getDownloadUrl, getPreviewUrl, getThumbnailUrl, getDocsStatus } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { isEditableOfficeFile } from "@/lib/office-files";
import { labelForMime } from "@/lib/mime-labels";
import type { FileEntryInfo } from "@/lib/types";
import { ReindexButton } from "./ReindexButton";

interface PreviewPaneProps {
  file: FileEntryInfo;
  onClose: () => void;
  onDownload: () => void;
  /**
   * WARP-882 — open the in-browser editor. The "Edit" affordance only renders
   * when this is supplied AND the doc-server engine is ready AND the file is an
   * editable Office MIME (no dead buttons).
   */
  onEdit?: () => void;
  /**
   * WARP-2204 — how the pane is hosted. Defaults to "modal", which is the
   * shipping behaviour every existing call site relies on.
   *
   * "docked" renders the SAME header and body with the modal chrome removed —
   * no backdrop, no fixed positioning, no z-index — so a surface that owns its
   * own layout (the chat file rail) can host the previewer beside its content
   * instead of over it. Dismissal belongs to that host in docked mode, which is
   * why Escape is not bound: in a rail, Escape closes the rail's drawer, and a
   * previewer that also claimed it would close the wrong thing.
   */
  mode?: "modal" | "docked";
  /**
   * WARP-2205 — where the bytes come from, when they are not in the files tree.
   *
   * A files-tree entry derives every URL from `file.path`. A CHAT ATTACHMENT
   * has no path at all: it is a BrainMemoryItem addressed by `itemId`, served
   * from /api/files/brain/:itemId/download. That is a different endpoint, not
   * a different path, so a host holding one supplies the URLs itself.
   *
   * `thumbnailUrl` is optional because the brain has no page-image service.
   * Without it an image still renders (straight from the preview bytes), and
   * an Office document falls to the honest "No preview available" state rather
   * than firing a request that is known to 404.
   */
  source?: {
    previewUrl: string;
    downloadUrl: string;
    thumbnailUrl?: string;
  };
}

const TEXT_EXTS = new Set([
  "txt", "md", "json", "yaml", "yml", "toml", "csv", "log",
  "xml", "html", "css", "js", "ts", "tsx", "py", "sh",
]);
const CODE_EXT = {
  json: "language-json", yaml: "language-yaml", yml: "language-yaml",
  js: "language-js", ts: "language-ts", tsx: "language-tsx",
  py: "language-python", sh: "language-shell",
} as const;

function getKind(file: FileEntryInfo): "image" | "pdf" | "video" | "audio" | "text" | "office" | "other" {
  const mime = file.mimeType ?? "";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  // WARP-1967: the text branch stays AHEAD of the office branch on purpose. A
  // .csv is in both sets — isEditableOfficeFile() admits it so the Edit button
  // can open it in the spreadsheet editor — but rendering it as text here is
  // faithful, instant, and needs no round-trip to the engine.
  if (TEXT_EXTS.has(ext) || mime.startsWith("text/")) return "text";
  // WARP-1967: Office documents render as a server-side page image. Same
  // predicate that gates the Edit button, so the two affordances can never
  // disagree about what "an Office file" is.
  if (isEditableOfficeFile(file)) return "office";
  return "other";
}

/**
 * File previewer supporting images, PDFs, video, audio, text and Office
 * documents. Videos and audio stream directly from the file endpoint. PDFs use
 * a native <object> tag with the browser's PDF viewer — no external JS lib.
 *
 * WARP-2204: hosted either as a full-bleed modal (the default, and what the
 * Files page uses) or DOCKED inside a host that owns its own layout. The two
 * differ only in chrome — the header and every body branch are shared, because
 * docking is a decision about where the previewer sits, not about what it can
 * show.
 *
 * Every embedded tag loads `getPreviewUrl`, NOT `getDownloadUrl`. The download
 * URL answers with `Content-Disposition: attachment`, and a browser honours that
 * inside <object> by downloading the file — which made Preview raise a Save-As
 * dialog over an empty modal instead of rendering. The preview URL is the same
 * bytes served inline. The Download button still uses the attachment URL, which
 * is the one place that behaviour is wanted.
 */
export function PreviewPane({
  file,
  onClose,
  onDownload,
  onEdit,
  mode = "modal",
  source,
}: PreviewPaneProps) {
  const docked = mode === "docked";
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  // WARP-882: the Edit affordance is gated on engine readiness. We only probe
  // status when the file is an editable Office MIME AND a handler is wired, so a
  // non-editable file (or a page that doesn't mount the editor) never makes a
  // needless call and never shows a dead button.
  const [docsReady, setDocsReady] = useState(false);
  // WARP-1967: an Office page image is rendered SERVER-side and can legitimately
  // be unavailable — the docs profile is RAM-gated off on a small box, and the
  // engine can be mid-restart. When the request fails we fall back to the same
  // honest empty state a binary blob gets, rather than a broken-image icon.
  // Keyed on the PATH that failed, not a bare boolean, and derived during
  // render rather than reset in an effect. useEffect runs AFTER paint, so
  // resetting a boolean there meant a reused modal (arrow-key paging, opening
  // another row) painted one frame of the PREVIOUS file's failure state —
  // "No preview available" under the new file's name — before the reset
  // landed. Deriving it makes the stale frame unrepresentable.
  const [failedThumbPath, setFailedThumbPath] = useState<string | null>(null);
  const officeThumbFailed = failedThumbPath === file.path;
  const editable = !!onEdit && isEditableOfficeFile(file);
  const kind = getKind(file);

  // WARP-2204: Escape belongs to whatever is modal, and a docked pane is not.
  // Binding it here in docked mode would fight the host for the keystroke — in
  // the chat file rail, Escape closes the rail's drawer. The listener is not
  // merely ignored in docked mode, it is never registered.
  useEffect(() => {
    if (docked) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, docked]);

  useEffect(() => {
    if (!editable) {
      setDocsReady(false);
      return;
    }
    let cancelled = false;
    getDocsStatus()
      .then((s) => {
        if (!cancelled) setDocsReady(s.state === "ready");
      })
      .catch(() => {
        if (!cancelled) setDocsReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editable, file.path]);

  useEffect(() => {
    if (kind !== "text") return;
    setTextContent(null);
    setTextError(null);
    let cancelled = false;
    authFetch(source?.downloadUrl ?? getDownloadUrl(file.path))
      .then((res) => res.text())
      .then((text) => {
        if (!cancelled) setTextContent(text.slice(0, 20_000));
      })
      .catch(() => {
        if (!cancelled) setTextError("Failed to load preview");
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, kind, source?.downloadUrl]);

  const previewUrl = source?.previewUrl ?? getPreviewUrl(file.path);
  // A host that supplies `source` but no thumbnail has no page-image service
  // behind it (the brain does not). Images fall back to the preview bytes,
  // which render fine; Office documents have nothing to fall back TO, so the
  // office branch degrades to the empty state instead of firing a doomed
  // request and waiting for its onError.
  const thumbnailUrl = source
    ? source.thumbnailUrl
    : getThumbnailUrl(file.path, 1024, 1024);

  // WARP-2204: the body branches used to hard-code `calc(90vh-64px)` — the
  // modal's own geometry (90vh card, 64px header) baked into every embed. A
  // docked pane has no relationship to the viewport; it fills whatever the host
  // gives it. Routing that one measurement through a custom property lets both
  // modes share the body verbatim: modal keeps the exact value it always had,
  // docked resolves to the host's height.
  const cardStyle = {
    padding: 0,
    borderRadius: "var(--radius-card)",
    "--preview-body-h": docked ? "100%" : "calc(90vh - 64px)",
  } as CSSProperties;

  const card = (
    <div
      className={
        docked
          // `min-h-0` is the non-obvious half of the scroll contract. The body
          // below is `flex-1 overflow-auto`, which only scrolls when its flex
          // parent is height-bounded. Modal gets that bound from `max-h-[90vh]`;
          // docked gets it from `h-full min-h-0` inside a bounded host. Without
          // it, flexbox's `min-height: auto` lets intrinsic content size win and
          // the chat shell's `overflow: hidden` CLIPS the pane instead.
          ? "card w-full h-full min-h-0 flex flex-col overflow-hidden"
          : "card max-w-5xl max-h-[90vh] w-full flex flex-col overflow-hidden shadow-2xl"
      }
      style={cardStyle}
      // Only meaningful under the modal backdrop, whose click closes the pane.
      onClick={docked ? undefined : (e) => e.stopPropagation()}
    >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <div className="flex-1 min-w-0">
            <h3
              className="type-headline truncate"
              style={{ color: "var(--text)" }}
            >
              {file.name}
            </h3>
            {/* WARP-1877: the type reads as words here for the same reason it
                does in the Files detail panel — this modal is one click from
                it, so a raw MIME leaking here undoes the fix. The full string
                stays reachable as the tooltip, and only when there is one. */}
            <p
              className="type-caption-1"
              title={file.mimeType || undefined}
              style={{ color: "var(--text-faint)" }}
            >
              {labelForMime(file.mimeType, file.name)}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {/* WARP-882: Edit — visible only when the doc-server engine is ready
                AND the file is an editable Office MIME. The server still decides
                edit-vs-view when the session is minted; this is the entry point,
                not an authorization claim. */}
            {editable && docsReady && (
              <button onClick={onEdit} className="btn primary sm" aria-label="Edit">
                <Pencil size={14} />
                <span className="hidden sm:inline">Edit</span>
              </button>
            )}
            {/* WARP-287: admin-only re-index trigger. The orchestrator's
                /api/admin/files/:id/reindex enforces RBAC + recent-MFA,
                so non-admins get a 403/401 and the button surfaces the
                "MFA required" path inline rather than failing silently. */}
            <ReindexButton fileId={file.path} />
            <button
              onClick={onDownload}
              className="icon-btn"
              style={{ width: 32, height: 32 }}
              aria-label="Download"
            >
              <Download size={16} />
            </button>
            <button
              onClick={onClose}
              className="icon-btn"
              style={{ width: 32, height: 32 }}
              aria-label="Close preview"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          className="flex-1 overflow-auto"
          style={{ background: "var(--inset)" }}
        >
          {kind === "image" && (
            <div className="flex items-center justify-center min-h-full p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl ?? previewUrl}
                alt={file.name}
                className="max-w-full object-contain"
                style={{ maxHeight: "var(--preview-body-h)" }}
                onError={(e) => {
                  // Fall back to the raw file bytes if the thumbnail API 404s
                  (e.target as HTMLImageElement).src = previewUrl;
                }}
              />
            </div>
          )}

          {kind === "pdf" && (
            <object
              data={`${previewUrl}#toolbar=0`}
              type="application/pdf"
              className="w-full"
              style={{ height: "var(--preview-body-h)" }}
            >
              <div
                className="flex flex-col items-center justify-center h-full gap-3 p-8"
                style={{ color: "var(--text-muted)" }}
              >
                <FileText size={32} />
                <p className="type-subheadline">Your browser can&apos;t embed PDFs.</p>
                <button onClick={onDownload} className="btn primary type-subheadline">
                  Download PDF
                </button>
              </div>
            </object>
          )}

          {kind === "video" && (
            <div className="flex items-center justify-center min-h-full p-4">
              <video
                src={previewUrl}
                controls
                className="max-w-full"
                style={{ maxHeight: "var(--preview-body-h)" }}
              />
            </div>
          )}

          {kind === "audio" && (
            <div className="flex items-center justify-center min-h-full p-12">
              <div
                className="p-6 max-w-md w-full"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--card-bd)",
                  borderRadius: "var(--radius-card)",
                }}
              >
                <p
                  className="type-headline mb-4 truncate"
                  style={{ color: "var(--text)" }}
                >
                  {file.name}
                </p>
                <audio src={previewUrl} controls className="w-full" />
              </div>
            </div>
          )}

          {kind === "text" && (
            <div className="p-4">
              {textContent === null && !textError && (
                <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
                  Loading…
                </p>
              )}
              {textError && (
                <p className="type-footnote" style={{ color: "var(--danger)" }}>
                  {textError}
                </p>
              )}
              {textContent !== null && (
                <pre
                  className={`type-footnote whitespace-pre-wrap font-mono p-4 ${
                    CODE_EXT[file.name.split(".").pop()?.toLowerCase() as keyof typeof CODE_EXT] ?? ""
                  }`}
                  style={{
                    color: "var(--text)",
                    background: "var(--surface)",
                    borderRadius: "var(--radius-input)",
                  }}
                >
                  {textContent}
                </pre>
              )}
            </div>
          )}

          {/* WARP-1967: Office documents. The orchestrator's thumbnail proxy
              asks Nextcloud for a page image, which richdocuments renders
              through Collabora — the same engine the Edit button opens, so a
              box that can edit a document can also show it. An <img> is the
              right tag rather than an iframe: it ignores Content-Disposition
              (the trap that broke the PDF branch), needs no editing session,
              and cannot execute anything the document carries. */}
          {kind === "office" && !officeThumbFailed && thumbnailUrl && (
            <div className="flex items-center justify-center min-h-full p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl}
                alt={`Preview of ${file.name}`}
                className="max-w-full object-contain"
                style={{ maxHeight: "var(--preview-body-h)" }}
                onError={() => setFailedThumbPath(file.path)}
              />
            </div>
          )}

          {(kind === "other" ||
            (kind === "office" && (officeThumbFailed || !thumbnailUrl))) && (
            <div className="empty">
              <div className="ei">
                <FileText size={22} />
              </div>
              <p className="eh">No preview available</p>
              <button onClick={onDownload} className="btn primary type-subheadline">
                <Download size={14} />
                Download
              </button>
            </div>
          )}
        </div>
    </div>
  );

  if (docked) return card;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      {card}
    </div>
  );
}
