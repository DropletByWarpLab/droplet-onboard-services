/**
 * WARP-1877 — MIME → friendly type name.
 *
 * A home user has no use for
 * "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
 * they want "Word document". The raw string stays reachable as a tooltip on
 * the surfaces that show one, but it is never the visible value.
 *
 * Companion to `mime-icons.ts`: that module owns MIME → glyph and the
 * canonical extension → MIME table, this one owns MIME → words. Adding a type
 * is a one-line edit in each.
 *
 * Every input shape a listing can hand us — absent, empty, opaque
 * ("application/octet-stream"), or a MIME we have never seen — resolves to a
 * non-empty string. This function does not throw.
 */

import { mimeFromPath } from "./mime-icons";

/** MIME types that carry no information — fall through to the file name. */
const OPAQUE_MIMES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
]);

const MIME_TO_LABEL: Record<string, string> = {
  // Word processing
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word document",
  "application/msword": "Word document",
  "application/vnd.oasis.opendocument.text": "OpenDocument text",
  "application/rtf": "Rich text document",
  "text/rtf": "Rich text document",
  // Spreadsheets
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "Excel spreadsheet",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet",
  "text/csv": "CSV spreadsheet",
  // Presentations
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint presentation",
  "application/vnd.ms-powerpoint": "PowerPoint presentation",
  "application/vnd.oasis.opendocument.presentation": "OpenDocument presentation",
  // Documents
  "application/pdf": "PDF document",
  "application/epub+zip": "EPUB book",
  // Text and data
  "text/plain": "Text file",
  "text/markdown": "Markdown document",
  "text/x-markdown": "Markdown document",
  "text/html": "HTML document",
  "application/xhtml+xml": "HTML document",
  "application/json": "JSON file",
  "application/xml": "XML file",
  "text/xml": "XML file",
  // Images
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/gif": "GIF image",
  "image/webp": "WebP image",
  "image/heic": "HEIC image",
  "image/heif": "HEIF image",
  "image/tiff": "TIFF image",
  "image/bmp": "Bitmap image",
  "image/svg+xml": "SVG image",
  // Archives
  "application/zip": "ZIP archive",
  "application/x-zip-compressed": "ZIP archive",
  "application/x-tar": "TAR archive",
  "application/gzip": "Gzip archive",
  "application/x-gzip": "Gzip archive",
  "application/x-bzip2": "Bzip2 archive",
  "application/x-7z-compressed": "7z archive",
  "application/vnd.rar": "RAR archive",
  "application/x-rar-compressed": "RAR archive",
  // Audio
  "audio/mpeg": "MP3 audio",
  "audio/mp4": "M4A audio",
  "audio/wav": "WAV audio",
  "audio/x-wav": "WAV audio",
  "audio/ogg": "Ogg audio",
  "audio/flac": "FLAC audio",
  "audio/webm": "WebM audio",
  "audio/aac": "AAC audio",
  // Video
  "video/mp4": "MP4 video",
  "video/quicktime": "QuickTime video",
  "video/x-matroska": "MKV video",
  "video/webm": "WebM video",
  "video/x-msvideo": "AVI video",
  "video/mpeg": "MPEG video",
  // Mail
  "message/rfc822": "Email message",
  "application/vnd.ms-outlook": "Email message",
  "application/x-msmail": "Email message",
};

/** Last-resort label for a MIME whose subtype we do not recognise. */
const FAMILY_TO_LABEL: Record<string, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  text: "Text file",
  font: "Font",
  message: "Email message",
};

/** Lower-cased type with any `; charset=…` parameters stripped. */
function normalizeMime(mime: string | null | undefined): string {
  if (typeof mime !== "string") return "";
  return mime.split(";")[0]!.trim().toLowerCase();
}

/** The file name's extension, when it is a plausible one. */
function extensionOf(fileName: string | null | undefined): string {
  if (typeof fileName !== "string") return "";
  const name = fileName.trim().toLowerCase();
  if (!name.includes(".")) return "";
  const ext = name.split(".").pop() ?? "";
  // "readme." and "…/a.very-long-suffix" are not extensions we can name.
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/**
 * A human-readable name for a file's type.
 *
 * @param mime     the listing's MIME type — may be absent, blank, or opaque
 * @param fileName the file name, used to recover a type the MIME did not give
 * @returns a non-empty label; "Unknown" when nothing can be determined
 */
export function labelForMime(
  mime?: string | null,
  fileName?: string | null
): string {
  const normalized = normalizeMime(mime);
  const informative = normalized && !OPAQUE_MIMES.has(normalized);

  if (informative) {
    const exact = MIME_TO_LABEL[normalized];
    if (exact) return exact;
  }

  // The MIME was absent, opaque, or unmapped — try the file name. The derived
  // label is a guess: `EXT_TO_MIME` is icon-oriented, so it resolves container
  // extensions toward audio (".ogg" → audio/ogg, ".webm" → audio/webm) because
  // headphones-vs-film is the only call it was built to make. It is not
  // authoritative. So when the server did give us an informative MIME, the
  // guess is accepted only if its family agrees — "video/ogg" on "movie.ogg"
  // must not become "Ogg audio". The no-MIME sibling case is NOT fixable here:
  // labelForMime("", "clip.webm") still says "WebM audio" for a video, because
  // with no MIME there is nothing to disagree with. That is the accepted cost
  // of one table serving both icons and labels — don't trust this branch's
  // output as a statement about the file.
  const ext = extensionOf(fileName);
  if (ext) {
    const derivedMime = mimeFromPath(`x.${ext}`);
    const derived = MIME_TO_LABEL[derivedMime];
    if (
      derived &&
      (!informative || derivedMime.split("/")[0] === normalized.split("/")[0])
    ) {
      return derived;
    }
  }

  if (informative) {
    const family = FAMILY_TO_LABEL[normalized.split("/")[0]!];
    if (family) return family;
  }

  // Last resort: name the extension itself. Only when it contains a letter —
  // "Backup 2026.01" and "report 1.28" are version-ish file names, not files
  // of type "01", and Nextcloud sends octet-stream often enough to route them
  // here. "7z" still qualifies. A purely numeric segment is better left
  // unnamed than confidently mislabelled.
  if (ext && /[a-z]/.test(ext)) return `${ext.toUpperCase()} file`;

  return "Unknown";
}
