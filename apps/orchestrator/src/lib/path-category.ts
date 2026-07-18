/**
 * WARP-1394 — TypeScript mirror of the `path_ext_to_category()` SQL
 * function defined in migrations/20260718000000_warp_1394_path_ext_to_category.
 *
 * Nextcloud-synced files (`FileIndexStatus` / watcher-written
 * `FileContentChunk` rows) carry no MIME type, so the context-meter
 * buckets them by file extension into the SAME 8 categories as
 * `mime_to_category()` (WARP-225). Like the mime classifier, the two
 * implementations keep byte-identical decision trees:
 *   1. A new extension goes into the SQL `CASE` (immutable migration).
 *   2. A matching entry lands in the sets here.
 *   3. A unit-test row goes into src/lib/path-category.test.ts.
 *
 * Classification rules (identical in SQL):
 *   - only the basename is considered (directory dots never classify);
 *   - the extension is everything after the LAST dot, lowercased;
 *   - dotfiles (".env"), extensionless names, and trailing-dot names
 *     are 'other'.
 */

import type { MimeCategory } from "./mime-category.js";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "opus", "aac"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);
const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "tiff",
  "tif",
  "bmp",
  "heic",
]);
const EMAIL_EXTS = new Set(["eml", "msg"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2"]);
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "htm",
  "docx",
  "doc",
  "rtf",
  "log",
  "yaml",
  "yml",
]);

export function pathToCategory(path: string | null | undefined): MimeCategory {
  if (!path) return "other";
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // dot === 0 is a dotfile, dot === -1 has no extension, a trailing dot
  // has an empty extension — all 'other'.
  if (dot <= 0 || dot === base.length - 1) return "other";
  const ext = base.slice(dot + 1).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (EMAIL_EXTS.has(ext)) return "email";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}
