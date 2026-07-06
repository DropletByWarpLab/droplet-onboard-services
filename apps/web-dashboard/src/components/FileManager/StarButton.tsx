"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { toggleFavorite } from "@/lib/api";

interface StarButtonProps {
  path: string;
  favorited: boolean;
  onToggle?: (next: boolean) => void;
  size?: number;
}

/**
 * Toggle favorite status for a file or directory.
 *
 * Optimistically flips the visible state on click, then reverts if the
 * orchestrator call fails. Consumers can pass `onToggle` to keep their
 * parent state in sync (e.g. to update a file list row).
 */
export function StarButton({ path, favorited, onToggle, size = 14 }: StarButtonProps) {
  const [current, setCurrent] = useState(favorited);
  const [pending, setPending] = useState(false);

  // Re-sync with the parent when the favorited prop changes (e.g. after the
  // parent's useFavorites SWR cache revalidates, or after an MQTT-driven
  // cross-tab change). Without this, useState(favorited) only samples the
  // prop on mount and the star can stay visually stale after an "add".
  useEffect(() => {
    setCurrent(favorited);
  }, [favorited]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    const next = !current;
    setCurrent(next);
    setPending(true);
    try {
      await toggleFavorite(path, next);
      onToggle?.(next);
    } catch {
      // Revert optimistic flip
      setCurrent(!next);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className="p-1.5 rounded-full transition-colors hover:bg-[var(--hover)]"
      style={{ color: current ? "var(--brand)" : "var(--text-muted)" }}
      aria-label={current ? "Remove from favorites" : "Add to favorites"}
      title={current ? "Remove from favorites" : "Add to favorites"}
    >
      <Star size={size} fill={current ? "currentColor" : "none"} />
    </button>
  );
}
