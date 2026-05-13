/**
 * WARP-331 — group conversations by date for the chat history sidebar.
 *
 * Buckets (in order): Today, Yesterday, Previous 7 days, Previous 30 days,
 * then per-month ("May 2026", "April 2025", ...). Callers must pass items
 * sorted newest-first; this function preserves that order within buckets.
 *
 * Generic over any shape carrying `{ id, title, updatedAt }` so we don't
 * duplicate the ConversationSummary interface — `api.ts` owns the wide
 * shape and this util just consumes what it needs.
 *
 * `now` is injected so tests can pin time.
 */
export interface DatedItem {
  id: string;
  title: string | null;
  updatedAt: string; // ISO
}

export interface ConversationGroup<T extends DatedItem = DatedItem> {
  label: string;
  items: T[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthLabel(d: Date): string {
  // Always include year so April-of-this-year ≠ April-of-last-year.
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

export function groupConversationsByDate<T extends DatedItem>(
  items: T[],
  now: Date,
): ConversationGroup<T>[] {
  if (items.length === 0) return [];

  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  // Insertion-ordered map so the result is in the desired chronological order.
  const buckets = new Map<string, T[]>();
  const ensure = (label: string): T[] => {
    let arr = buckets.get(label);
    if (!arr) {
      arr = [];
      buckets.set(label, arr);
    }
    return arr;
  };

  // Seed in display order so an empty Today doesn't push Yesterday to the top
  // accidentally — we drop empty buckets at the end.
  ensure("Today");
  ensure("Yesterday");
  ensure("Previous 7 days");
  ensure("Previous 30 days");

  for (const item of items) {
    const updated = new Date(item.updatedAt);
    if (Number.isNaN(updated.getTime())) continue;
    const day = startOfDay(updated);
    if (day.getTime() === today.getTime()) ensure("Today").push(item);
    else if (day.getTime() === yesterday.getTime()) ensure("Yesterday").push(item);
    else if (day >= sevenDaysAgo) ensure("Previous 7 days").push(item);
    else if (day >= thirtyDaysAgo) ensure("Previous 30 days").push(item);
    else ensure(monthLabel(updated)).push(item);
  }

  return Array.from(buckets.entries())
    .filter(([, arr]) => arr.length > 0)
    .map(([label, items]) => ({ label, items }));
}
