"use client";

/**
 * WARP-225 — last 10 indexed items.
 *
 * Source icon (per WARP-214 set), filename, relative timestamp, chunk
 * count. No actions; this list is read-only situational awareness.
 */

import type { RecentlyIndexedItem } from "@/lib/types-context-stats";
import { iconForCategory } from "@/lib/category-icons";
import { formatRelativeTime } from "@/lib/relative-time";

interface Props {
  items: RecentlyIndexedItem[];
}

export function RecentlyIndexed({ items }: Props) {
  if (items.length === 0) {
    return (
      <div className="dp-tile p-6 flex flex-col gap-2 min-h-[180px]">
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          Recently Indexed
        </p>
        <p className="type-footnote text-label-tertiary">
          Nothing yet. Drop a file into a chat to start building your context.
        </p>
      </div>
    );
  }

  return (
    <div className="dp-tile p-6" data-testid="recently-indexed">
      <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em] mb-4">
        Recently Indexed
      </p>
      <ul className="divide-y divide-separator">
        {items.map((it) => {
          const Icon = iconForCategory(it.category);
          return (
            <li
              key={it.id}
              className="flex items-center gap-3 py-3"
              data-testid="recently-indexed-item"
            >
              <span className="w-8 h-8 rounded-md bg-surface-secondary flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-label-secondary" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary truncate">
                  {it.filename}
                </p>
                <p className="type-caption-1 text-label-tertiary">
                  {formatRelativeTime(it.indexedAt)}
                  <span className="mx-1.5">·</span>
                  {it.chunkCount} chunk{it.chunkCount === 1 ? "" : "s"}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
