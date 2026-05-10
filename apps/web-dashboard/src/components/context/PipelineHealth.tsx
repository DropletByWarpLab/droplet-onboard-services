"use client";

/**
 * WARP-225 — per-extractor pipeline-health grid.
 *
 * One row per MIME category. Status icon + extractor name + count +
 * avg-time-to-ready or fallback ("never reached ready"). Failures
 * surface a red AlertTriangle inline.
 *
 * Lightweight on purpose — no expanding-row interaction here yet
 * (spec mentions "click expands to file list", but the queued/failed
 * lists already drill down on the same data and we don't want to
 * clutter the polish page with a fourth list rendering. Easy follow-up
 * if the click-through is missed in review).
 */

import { motion } from "framer-motion";
import { AlertTriangle, Check, Clock } from "lucide-react";
import type { PipelineHealthRow } from "@/lib/types-context-stats";
import { iconForCategory, labelForCategory } from "@/lib/category-icons";

interface Props {
  rows: PipelineHealthRow[];
}

const EXTRACTOR_NAME: Record<string, string> = {
  audio: "Audio (faster-whisper)",
  video: "Video (subs / frame OCR)",
  pdf: "PDF",
  image: "Image (Tesseract OCR)",
  email: "Email + nested",
  archive: "Archive (zip / tar / gzip)",
  text: "Documents (text / docx / md / json)",
  other: "Other",
};

function formatSeconds(s: number | null): string {
  if (s === null) return "never reached ready";
  if (s < 1) return `avg ${(s * 1000).toFixed(0)}ms`;
  if (s < 60) return `avg ${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `avg ${m}m ${r}s`;
}

export function PipelineHealth({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="dp-tile p-6 flex flex-col gap-2 min-h-[180px]">
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          Pipeline Health
        </p>
        <p className="type-footnote text-label-tertiary">
          No extractor activity yet.
        </p>
      </div>
    );
  }

  return (
    <div className="dp-tile p-6" data-testid="pipeline-health">
      <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em] mb-4">
        Pipeline Health
      </p>
      <ul className="divide-y divide-separator">
        {rows.map((row, idx) => {
          const Icon = iconForCategory(row.category);
          const StatusIcon =
            row.failed > 0
              ? AlertTriangle
              : row.avgSecondsToReady === null
                ? Clock
                : Check;
          const tone =
            row.failed > 0
              ? "text-system-red"
              : row.avgSecondsToReady === null
                ? "text-system-orange"
                : "text-system-green";
          return (
            <motion.li
              key={row.category}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: idx * 0.04 }}
              className="flex items-center gap-3 py-3"
            >
              <span className="w-7 h-7 rounded-md bg-surface-secondary flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-label-secondary" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {EXTRACTOR_NAME[row.category] ?? labelForCategory(row.category)}
                </p>
                <p className="type-caption-1 text-label-tertiary truncate">
                  {row.files} file{row.files === 1 ? "" : "s"}
                  <span className="mx-1.5">·</span>
                  {formatSeconds(row.avgSecondsToReady)}
                  {row.failed > 0 && (
                    <>
                      <span className="mx-1.5">·</span>
                      <span className="text-system-red">
                        {row.failed} failed
                      </span>
                    </>
                  )}
                </p>
              </div>
              <StatusIcon size={16} className={`flex-shrink-0 ${tone}`} />
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
