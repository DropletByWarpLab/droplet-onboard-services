"use client";

/**
 * WARP-225 — drill-down queued-items list with per-item "Run now".
 *
 * Renders only when count > 0 (parent gates the render — this
 * component assumes non-empty data, but is defensive in case).
 *
 * Each row's "Run now" → POST /api/files/brain/:id/transcribe-now (the
 * existing WARP-218 endpoint). Surfaces 429 + Retry-After inline so
 * the user sees "Retry available in <X minutes>" without a toast.
 */

import { useState } from "react";
import { Play, Loader2 } from "lucide-react";
import type { QueuedItem } from "@/lib/types-context-stats";
import { iconForCategory } from "@/lib/category-icons";
import { transcribeNowBrainItem } from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";

interface Props {
  items: QueuedItem[];
  onChange?: () => void;
}

interface RowState {
  busy: boolean;
  error: string | null;
}

export function QueuedList({ items, onChange }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>({});

  if (items.length === 0) return null;

  async function runNow(id: string) {
    setRows((s) => ({ ...s, [id]: { busy: true, error: null } }));
    try {
      const res = await transcribeNowBrainItem(id);
      if (res.ok) {
        setRows((s) => ({ ...s, [id]: { busy: false, error: null } }));
        onChange?.();
      } else if (res.status === 429) {
        const mins = res.retryAfterSeconds
          ? Math.max(1, Math.ceil(res.retryAfterSeconds / 60))
          : null;
        setRows((s) => ({
          ...s,
          [id]: {
            busy: false,
            error: mins
              ? `Retry available in ${mins} min${mins === 1 ? "" : "s"}`
              : "Rate limited",
          },
        }));
      } else {
        setRows((s) => ({
          ...s,
          [id]: { busy: false, error: `Failed (${res.status})` },
        }));
      }
    } catch {
      setRows((s) => ({
        ...s,
        [id]: { busy: false, error: "Network error" },
      }));
    }
  }

  return (
    <div className="dp-tile p-6" data-testid="queued-list">
      <div className="flex items-center justify-between mb-4">
        <p className="type-caption-1 text-system-orange uppercase tracking-[0.18em]">
          Queued
        </p>
        <p className="type-caption-1 text-label-tertiary">
          {items.length} waiting
        </p>
      </div>
      <ul className="divide-y divide-separator">
        {items.map((it) => {
          const Icon = iconForCategory(it.category);
          const state = rows[it.id] ?? { busy: false, error: null };
          return (
            <li
              key={it.id}
              className="flex items-start gap-3 py-3"
              data-testid="queued-item"
            >
              <span className="w-8 h-8 rounded-md bg-surface-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon size={15} className="text-label-secondary" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {it.filename}
                </p>
                <p className="type-caption-1 text-label-tertiary truncate">
                  {it.reason}
                  <span className="mx-1.5">·</span>
                  uploaded {formatRelativeTime(it.uploadedAt)}
                </p>
                {state.error && (
                  <p className="type-caption-1 text-system-orange mt-1">
                    {state.error}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => runNow(it.id)}
                disabled={state.busy}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-full type-footnote font-medium border border-separator text-label-primary hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label={`Run extractor now for ${it.filename}`}
              >
                {state.busy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Play size={12} />
                )}
                Run now
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
