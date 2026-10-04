"use client";
/**
 * WARP-3691 — a file shown inline in chat (from the `show_file` tool).
 *
 * Images render as a picture (the thumbnail route when there is one, else the
 * inline-preview bytes); anything else is a name/size card. Both open the
 * existing PreviewPane, fed the URLs the descriptor carries, so the preview
 * path is the same one the Files page and attachments already use and the
 * server's inline safelist still decides what may render. SVG is deliberately
 * NOT drawn as an image here: the server refuses to serve it inline (it can
 * carry script), so it gets the file card and a download.
 */
import { useState } from "react";
import { Download, Eye, File as FileIcon, FileText } from "lucide-react";
import type { FileMedia } from "@droplet/shared-types";
import { PreviewPane } from "@/components/FileManager/PreviewPane";
import { formatBytes } from "@/lib/format-bytes";
import type { FileEntryInfo } from "@/lib/types";
import { MediaCaption, MediaError, MediaFrame, errorCopy, probeStatus, safeSrc } from "./shared";

function isDrawableImage(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

export function FileMediaCard({ media }: { media: FileMedia }) {
  const previewUrl = safeSrc(media.previewUrl);
  const downloadUrl = safeSrc(media.downloadUrl);
  const thumbnailUrl = safeSrc(media.thumbnailUrl);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!previewUrl || !downloadUrl) return null;

  const image = isDrawableImage(media.mimeType);
  const entry: FileEntryInfo = {
    name: media.name,
    // The previewer derives nothing from `path` once `source` is supplied; the
    // real path (when there is one) keeps its Office-thumbnail failure key unique.
    path: media.path ?? media.name,
    isDirectory: false,
    size: media.size ?? 0,
    mimeType: media.mimeType,
    modifiedAt: "",
  };
  const size = media.size ? formatBytes(media.size) : null;
  const Icon = media.mimeType.startsWith("text/") || media.mimeType === "application/pdf" ? FileText : FileIcon;

  return (
    <>
      <MediaFrame testId="file-media-card" label={`File, ${media.name}`}>
        {image && !error ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block w-full bg-[var(--card-inner)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            aria-label={`Open ${media.name}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl ?? previewUrl}
              alt={media.name}
              className="block w-full max-h-80 object-contain"
              loading="lazy"
              onError={() => {
                void probeStatus(thumbnailUrl ?? previewUrl).then((s) => setError(errorCopy(s, false)));
              }}
            />
          </button>
        ) : error ? (
          <MediaError message={error} />
        ) : (
          <div className="flex items-center gap-3 px-3 py-4 bg-[var(--card-inner)]">
            <Icon size={28} className="text-[var(--text-faint)] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="type-subheadline font-medium text-[var(--text)] truncate">{media.name}</div>
              <div className="type-caption-1 text-[var(--text-muted)]">
                {[media.mimeType, size].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
        )}
        <MediaCaption>
          {image ? <span className="font-medium text-[var(--text)] truncate">{media.name}</span> : null}
          {image && size ? <span>{size}</span> : null}
          <span className="flex-1" />
          <button type="button" className="btn sm" onClick={() => setOpen(true)}>
            <Eye size={14} aria-hidden="true" />
            <span>Open</span>
          </button>
          <a className="btn sm" href={downloadUrl} download={media.name}>
            <Download size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Download</span>
          </a>
        </MediaCaption>
      </MediaFrame>
      {open ? (
        <PreviewPane
          file={entry}
          onClose={() => setOpen(false)}
          onDownload={() => {
            window.location.assign(downloadUrl);
          }}
          source={{ previewUrl, downloadUrl, thumbnailUrl }}
        />
      ) : null}
    </>
  );
}
