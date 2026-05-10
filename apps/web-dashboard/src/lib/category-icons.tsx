/**
 * WARP-225 — MimeCategory → Lucide icon mapping.
 *
 * Reuses the WARP-214 object-icon set so the home widget, /context page
 * source-strip, and /knowledge tab all read consistently. Adding a new
 * category requires updating both `mime_to_category()` (SQL + TS twin)
 * AND this file.
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
import type { MimeCategory } from "./types-context-stats";

const ICON_BY_CATEGORY: Record<MimeCategory, LucideIcon> = {
  audio: Headphones,
  video: Film,
  pdf: FileText,
  image: ImageIcon,
  email: Mail,
  archive: FileArchive,
  text: FileText,
  other: FileText,
};

export function iconForCategory(cat: MimeCategory): LucideIcon {
  return ICON_BY_CATEGORY[cat] ?? FileText;
}

const LABEL_BY_CATEGORY: Record<MimeCategory, string> = {
  audio: "Audio",
  video: "Video",
  pdf: "PDFs",
  image: "Images",
  email: "Email",
  archive: "Archives",
  text: "Documents",
  other: "Other",
};

export function labelForCategory(cat: MimeCategory): string {
  return LABEL_BY_CATEGORY[cat] ?? "Other";
}
