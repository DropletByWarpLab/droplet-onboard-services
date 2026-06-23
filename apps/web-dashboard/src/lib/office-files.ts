/**
 * WARP-882 / WS-4 — which files the OnlyOffice engine can open for editing.
 *
 * Used to gate the "Edit" affordance so it never renders for a file the engine
 * can't handle (no dead buttons). Matches on extension AND the common Office
 * MIME types — a Nextcloud listing may carry either.
 */
import type { FileEntryInfo } from "./types";

/** Editable Office extensions (word / spreadsheet / presentation, OOXML + ODF). */
const EDITABLE_OFFICE_EXTS = new Set([
  // Word
  "docx", "doc", "odt", "rtf",
  // Spreadsheet
  "xlsx", "xls", "ods", "csv",
  // Presentation
  "pptx", "ppt", "odp",
]);

const EDITABLE_OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "application/vnd.oasis.opendocument.text", // odt
  "application/rtf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "text/csv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.ms-powerpoint", // ppt
  "application/vnd.oasis.opendocument.presentation", // odp
]);

/** True when `file` is an editable Office document the engine can open. */
export function isEditableOfficeFile(file: Pick<FileEntryInfo, "name" | "mimeType" | "isDirectory">): boolean {
  if (file.isDirectory) return false;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (EDITABLE_OFFICE_EXTS.has(ext)) return true;
  const mime = (file.mimeType ?? "").toLowerCase();
  return EDITABLE_OFFICE_MIMES.has(mime);
}
