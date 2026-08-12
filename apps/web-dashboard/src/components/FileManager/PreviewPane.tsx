"use client";

import { useEffect, useState } from "react";
import { X, Download, FileText, Pencil } from "lucide-react";
import { getDownloadUrl, getThumbnailUrl, getDocsStatus } from "@/lib/api";
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

function getKind(file: FileEntryInfo): "image" | "pdf" | "video" | "audio" | "text" | "other" {
  const mime = file.mimeType ?? "";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (TEXT_EXTS.has(ext) || mime.startsWith("text/")) return "text";
  return "other";
}

/**
 * Full-bleed preview modal supporting images, PDFs, video, audio, and text.
 * Videos and audio stream directly from the download endpoint. PDFs use a
 * native <object> tag with the browser's PDF viewer — no external JS lib.
 */
export function PreviewPane({ file, onClose, onDownload, onEdit }: PreviewPaneProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  // WARP-882: the Edit affordance is gated on engine readiness. We only probe
  // status when the file is an editable Office MIME AND a handler is wired, so a
  // non-editable file (or a page that doesn't mount the editor) never makes a
  // needless call and never shows a dead button.
  const [docsReady, setDocsReady] = useState(false);
  const editable = !!onEdit && isEditableOfficeFile(file);
  const kind = getKind(file);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

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
    authFetch(getDownloadUrl(file.path))
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
  }, [file.path, kind]);

  const downloadUrl = getDownloadUrl(file.path);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="card max-w-5xl max-h-[90vh] w-full flex flex-col overflow-hidden shadow-2xl"
        style={{ padding: 0, borderRadius: "var(--radius-card)" }}
        onClick={(e) => e.stopPropagation()}
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
                src={getThumbnailUrl(file.path, 1024, 1024)}
                alt={file.name}
                className="max-w-full max-h-[calc(90vh-64px)] object-contain"
                onError={(e) => {
                  // Fall back to the raw download endpoint if the preview API 404s
                  (e.target as HTMLImageElement).src = downloadUrl;
                }}
              />
            </div>
          )}

          {kind === "pdf" && (
            <object
              data={`${downloadUrl}#toolbar=0`}
              type="application/pdf"
              className="w-full h-[calc(90vh-64px)]"
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
                src={downloadUrl}
                controls
                className="max-w-full max-h-[calc(90vh-64px)]"
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
                <audio src={downloadUrl} controls className="w-full" />
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

          {kind === "other" && (
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
    </div>
  );
}
