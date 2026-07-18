"use client";

/**
 * WARP-225 — drill-down failed-items list with per-item "Retry".
 *
 * Renders only when count > 0. Each row's "Retry" → POST
 * /api/me/context-stats/failed/:id/retry. Surfaces 429 + Retry-After
 * inline (the orchestrator's per-item rolling-hour cap is shared with
 * /transcribe-now).
 */

import { useState } from "react";
import { RotateCcw, Loader2, AlertTriangle } from "lucide-react";
import type { FailedItem } from "@/lib/types-context-stats";
import { iconForCategory } from "@/lib/category-icons";
import { retryFailedContextItem } from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";

interface Props {
  items: FailedItem[];
  onChange?: () => void;
}

interface RowState {
  busy: boolean;
  error: string | null;
  done: boolean;
}

export function FailedList({ items, onChange }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>({});

  if (items.length === 0) return null;

  async function retry(id: string) {
    setRows((s) => ({ ...s, [id]: { busy: true, error: null, done: false } }));
    try {
      const res = await retryFailedContextItem(id);
      if (res.ok) {
        setRows((s) => ({
          ...s,
          [id]: { busy: false, error: null, done: true },
        }));
        onChange?.();
      } else if (res.status === 429) {
        const mins = res.retryAfterSeconds
          ? Math.max(1, Math.ceil(res.retryAfterSeconds / 60))
          : null;
        setRows((s) => ({
          ...s,
          [id]: {
            busy: false,
            done: false,
            error: mins
              ? `Retry available in ${mins} min${mins === 1 ? "" : "s"}`
              : "Rate limited (max 3 retries per hour)",
          },
        }));
      } else if (res.status === 404) {
        setRows((s) => ({
          ...s,
          [id]: { busy: false, done: false, error: "Not found" },
        }));
      } else {
        setRows((s) => ({
          ...s,
          [id]: {
            busy: false,
            done: false,
            error: `Failed (${res.status})`,
          },
        }));
      }
    } catch {
      setRows((s) => ({
        ...s,
        [id]: { busy: false, done: false, error: "Network error" },
      }));
    }
  }

  return (
    <div className="dp-tile p-6" data-testid="failed-list">
      <div className="flex items-center justify-between mb-4">
        <p className="type-caption-1 text-system-red uppercase tracking-[0.18em]">
          Failed
        </p>
        <p className="type-caption-1 text-label-tertiary">
          {items.length} need attention
        </p>
      </div>
      <ul className="divide-y divide-separator">
        {items.map((it) => {
          const Icon = iconForCategory(it.category);
          const state = rows[it.id] ?? { busy: false, error: null, done: false };
          return (
            <li
              key={it.id}
              className="flex items-start gap-3 py-3"
              data-testid="failed-item"
            >
              <span className="w-8 h-8 rounded-md bg-system-red/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon size={15} className="text-system-red" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {it.filename}
                </p>
                <p className="type-caption-1 text-label-tertiary truncate">
                  {it.failureReason ? (
                    <>
                      <AlertTriangle
                        size={10}
                        className="inline -mt-0.5 mr-1 text-system-red"
                      />
                      {it.failureReason}
                    </>
                  ) : (
                    "Unknown failure"
                  )}
                  {it.lastAttemptedAt && (
                    <>
                      <span className="mx-1.5">·</span>
                      last tried {formatRelativeTime(it.lastAttemptedAt)}
                    </>
                  )}
                  {it.recentAttemptCount > 0 && (
                    <>
                      <span className="mx-1.5">·</span>
                      {it.recentAttemptCount}/3 retries this hour
                    </>
                  )}
                </p>
                {state.error && (
                  <p className="type-caption-1 text-system-orange mt-1">
                    {state.error}
                  </p>
                )}
                {state.done && (
                  <p className="type-caption-1 text-system-green mt-1">
                    Retry queued
                  </p>
                )}
              </div>
              {/* WARP-1394: the retry route flips BrainMemoryItem rows
                  back to queued_for_transcription; synced failures are
                  watcher-owned, so nextcloud rows carry no action. */}
              {it.source !== "nextcloud" && (
              <button
                type="button"
                onClick={() => retry(it.id)}
                disabled={state.busy || state.done}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-full type-footnote font-medium border border-separator text-label-primary hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label={`Retry indexing for ${it.filename}`}
              >
                {state.busy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Retry
              </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
