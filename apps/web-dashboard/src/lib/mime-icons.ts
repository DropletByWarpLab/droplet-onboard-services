/**
 * WARP-214 — central MIME → Lucide icon mapping.
 *
 * Object-icon set: distinct silhouettes that read at chip size (16-20px) and
 * card size (28-32px). Headphones for audio, Film for video, Mail for email,
 * FileArchive for archives. Phase 1 types (text/pdf/docx) keep the existing
 * FileText icon; image/* uses ImageIcon. Unknown MIMEs fall back to FileText.
 *
 * Single source of truth — every dashboard surface (RecentlyIndexedTab,
 * BrainMemoryTab, SearchTab, citation viewers, Breadcrumbs) imports
 * `iconForMime` so adding a new MIME class is a one-line edit.
 */

import {
  FileArchive,
  FileText,
  Film,
  Headphones,
  Image as ImageIcon,
  Mail,
  type LucideIcon,
} from "lucide-react";

const MIME_TO_ICON: Record<string, LucideIcon> = {
  // audio (WARP-197)
  "audio/mpeg": Headphones,
  "audio/mp4": Headphones,
  "audio/wav": Headphones,
  "audio/x-wav": Headphones,
  "audio/ogg": Headphones,
  "audio/flac": Headphones,
  "audio/webm": Headphones,
  "audio/aac": Headphones,
  // video (WARP-198)
  "video/mp4": Film,
  "video/quicktime": Film,
  "video/x-matroska": Film,
  "video/webm": Film,
  "video/x-msvideo": Film,
  "video/mpeg": Film,
  // email (WARP-199)
  "message/rfc822": Mail,
  "application/vnd.ms-outlook": Mail,
  "application/x-msmail": Mail,
  // archive (WARP-200)
  "application/zip": FileArchive,
  "application/x-zip-compressed": FileArchive,
  "application/x-tar": FileArchive,
  "application/gzip": FileArchive,
  "application/x-gzip": FileArchive,
  "application/x-bzip2": FileArchive,
  "application/x-7z-compressed": FileArchive,
  "application/vnd.rar": FileArchive,
  // Phase 1 docs (WARP-201)
  "application/pdf": FileText,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    FileText,
  "application/msword": FileText,
  "text/plain": FileText,
  "text/markdown": FileText,
  "text/csv": FileText,
  "text/html": FileText,
  "text/x-markdown": FileText,
  "application/json": FileText,
  "application/xml": FileText,
};

/**
 * Look up a Lucide icon component for a MIME type.
 * Image MIMEs (image/png, image/jpeg, etc.) all return ImageIcon; everything
 * else uses an explicit table entry, falling back to FileText.
 */
export function iconForMime(mime: string): LucideIcon {
  if (mime && mime.startsWith("image/")) return ImageIcon;
  return MIME_TO_ICON[mime] ?? FileText;
}

/**
 * Best-effort extension → MIME map. Used by the RecentlyIndexedTab and
 * SearchTab where the orchestrator's KnowledgeChunkItem doesn't carry a
 * mimeType (the row is keyed by `path`). This keeps WARP-214 frontend-only —
 * no extra orchestrator-side fetch.
 */
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  // WARP-1877: the rest of the Office/ODF set, so a listing with no mimeType
  // still resolves to a named type in the Files detail panel.
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

export function mimeFromPath(path: string): string {
  if (!path) return "application/octet-stream";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // Bare filenames with no dot collapse to the whole string here, so guard.
  if (!ext || ext === path.toLowerCase()) return "application/octet-stream";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}
