"use client";

import { useEffect, useState } from "react";
import { X, Download, FileText } from "lucide-react";
import { getDownloadUrl, getThumbnailUrl } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { FileEntryInfo } from "@/lib/types";

interface PreviewPaneProps {
  file: FileEntryInfo;
  onClose: () => void;
  onDownload: () => void;
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
export function PreviewPane({ file, onClose, onDownload }: PreviewPaneProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const kind = getKind(file);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

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
        className="bg-surface-primary rounded-lg max-w-5xl max-h-[90vh] w-full flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-separator flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="type-headline text-label-primary truncate">
              {file.name}
            </h3>
            <p className="type-caption-1 text-label-tertiary">
              {file.mimeType || "Unknown type"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onDownload}
              className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
              title="Download"
            >
              <Download size={16} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-surface-secondary">
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
              <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-label-tertiary">
                <FileText size={32} />
                <p className="type-subheadline">Your browser can&apos;t embed PDFs.</p>
                <button onClick={onDownload} className="dp-btn-primary type-subheadline">
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
              <div className="dp-card p-6 max-w-md w-full">
                <p className="type-headline text-label-primary mb-4 truncate">{file.name}</p>
                <audio src={downloadUrl} controls className="w-full" />
              </div>
            </div>
          )}

          {kind === "text" && (
            <div className="p-4">
              {textContent === null && !textError && (
                <p className="type-footnote text-label-tertiary">Loading…</p>
              )}
              {textError && (
                <p className="type-footnote text-system-red">{textError}</p>
              )}
              {textContent !== null && (
                <pre
                  className={`type-footnote text-label-primary whitespace-pre-wrap font-mono bg-surface-primary p-4 rounded ${
                    CODE_EXT[file.name.split(".").pop()?.toLowerCase() as keyof typeof CODE_EXT] ?? ""
                  }`}
                >
                  {textContent}
                </pre>
              )}
            </div>
          )}

          {kind === "other" && (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-12 text-label-tertiary">
              <FileText size={32} className="text-label-quaternary" />
              <p className="type-subheadline">No preview available</p>
              <button onClick={onDownload} className="dp-btn-primary type-subheadline">
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
