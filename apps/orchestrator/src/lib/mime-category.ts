/**
 * WARP-225 — TypeScript mirror of the `mime_to_category()` SQL function
 * defined in migrations/20260510000000_warp_225_mime_to_category.
 *
 * Why a TypeScript twin:
 *   - Unit tests can exercise every WARP-201..208 MIME type without a
 *     live Postgres (the orchestrator's vitest run is hermetic — see
 *     src/__tests__/setup.ts for the @prisma/client mock).
 *   - The dashboard widget can reuse the same classifier for client-side
 *     icon selection / fallback rendering.
 *
 * Both implementations are kept byte-identical in their decision tree.
 * Adding a new MIME class requires:
 *   1. A new branch in the SQL `CASE` (immutable migration).
 *   2. A matching branch here.
 *   3. A unit-test row in src/lib/mime-category.test.ts.
 */

export type MimeCategory =
  | "audio"
  | "video"
  | "pdf"
  | "image"
  | "email"
  | "archive"
  | "text"
  | "other";

const EMAIL_MIMES = new Set<string>([
  "message/rfc822",
  "application/vnd.ms-outlook",
  "application/x-msmail",
]);

const ARCHIVE_MIMES = new Set<string>([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip2",
]);

const TEXT_DOC_MIMES = new Set<string>([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/json",
  "application/xml",
]);

export function mimeToCategory(mime: string | null | undefined): MimeCategory {
  if (!mime) return "other";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (EMAIL_MIMES.has(mime)) return "email";
  if (ARCHIVE_MIMES.has(mime)) return "archive";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (TEXT_DOC_MIMES.has(mime)) return "text";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

/** All categories rendered by the dashboard, in display order. */
export const CATEGORY_ORDER: readonly MimeCategory[] = [
  "audio",
  "video",
  "pdf",
  "image",
  "email",
  "archive",
  "text",
  "other",
] as const;
