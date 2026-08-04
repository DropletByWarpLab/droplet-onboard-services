// Pure helpers for `GET /api/files/:id/content` (the dashboard citation
// viewers). Kept dependency-free so they unit-test without the Nextcloud /
// Prisma / fs glue the route wires them into.

export type FileContentId =
  | { kind: "ncfile"; ncFileId: number }
  | { kind: "path"; path: string }
  | { kind: "brain"; itemId: string };

/**
 * Classify the polymorphic `:id` the citation viewers send to
 * `/api/files/:id/content`. The dashboard sets it to one of three things:
 *   - a stringified numeric Nextcloud file id (knowledge SearchTab:
 *     `hit.ncFileId ? String(hit.ncFileId) : hit.path`)
 *   - a home-relative path beginning with "/" (the fallback above, and the
 *     chat fallback when there's no brain id)
 *   - a brain-memory item id / UUID (chat ChatMessage:
 *     `c.brainItemId ? String(c.brainItemId) : c.path`)
 */
export function classifyFileContentId(id: string): FileContentId {
  if (/^\d+$/.test(id)) return { kind: "ncfile", ncFileId: Number(id) };
  if (id.startsWith("/")) return { kind: "path", path: id };
  return { kind: "brain", itemId: id };
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
};

/** Best-effort Content-Type from a filename extension (default octet-stream). */
export function contentTypeForFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range HTTP `Range` header against a known content `size`.
 * Returns the inclusive 0-indexed byte range; `null` when the header is
 * absent / multi-range / unparseable (caller serves the full 200);
 * `{ unsatisfiable: true }` when syntactically valid but outside the
 * content (caller → 416). Used by the local-file (brain) branch; the
 * Nextcloud branch forwards the raw header to WebDAV instead.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): ByteRange | { unsatisfiable: true } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (start > end || start >= size) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}
