"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * WARP-295: sticky-bottom auto-scroll for the chat surface.
 *
 * The pre-WARP-295 chat page called `scrollIntoView` unconditionally on
 * every messages-array change, which yanked the user back to the bottom
 * even when they had scrolled up to re-read a citation. The audit (§5.4)
 * flagged this as a should-fix.
 *
 * The hook owns three pieces:
 *
 *   - a ref the page attaches to the scroll container,
 *   - an `isDetached` boolean (true when the user has scrolled up away
 *     from the live tail — defined as `scrollHeight - scrollTop -
 *     clientHeight >= STICKY_PX`),
 *   - a `scrollToBottom()` callback the "Jump to latest" pill wires to.
 *
 * `useStickyEffect(dep)` is the sentinel hook callers use to drive the
 * "auto-scroll when sticky, no-op when detached" behavior: pass the
 * messages array (or its length) as the dep, and the effect handles the
 * conditional scrollIntoView. Keeping that wiring in the hook means the
 * page never has to read scroll positions itself.
 *
 * Threshold rationale: 80px = ~3 lines of body type plus the bubble
 * padding. Below that the user is clearly trying to track the live tail.
 */

export const STICKY_PX = 80;

export interface UseStickyScrollResult {
  /** Ref to attach to the scroll container (`<div className="overflow-y-auto">`). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled up off the live tail. */
  isDetached: boolean;
  /** Imperatively scroll to the bottom and re-attach. */
  scrollToBottom: () => void;
  /** Wire this to the scroll container's `onScroll`. */
  onScroll: () => void;
  /**
   * Run inside a useEffect whose dep is the messages array (or its
   * length). Performs the sticky-scroll: scrolls to bottom only when
   * the user is attached. No-op when detached.
   */
  stickyScrollToBottom: () => void;
}

export function useStickyScroll(): UseStickyScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  // We mirror `isDetached` in a ref so `stickyScrollToBottom` reads the
  // current value synchronously inside the effect body — otherwise the
  // closure captures the value at the time `useEffect` registered.
  const isDetachedRef = useRef(false);
  const [isDetached, setIsDetached] = useState(false);

  const computeDetached = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight >= STICKY_PX;
  }, []);

  const onScroll = useCallback(() => {
    const detached = computeDetached();
    if (detached !== isDetachedRef.current) {
      isDetachedRef.current = detached;
      setIsDetached(detached);
    }
  }, [computeDetached]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (isDetachedRef.current) {
      isDetachedRef.current = false;
      setIsDetached(false);
    }
  }, []);

  const stickyScrollToBottom = useCallback(() => {
    // Recompute detach state from the latest scroll position — a new
    // message that arrives mid-scroll changes scrollHeight so we have
    // to re-evaluate before deciding to scroll.
    if (computeDetached()) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [computeDetached]);

  // Re-evaluate detach state on resize — the scroll container's
  // clientHeight changes when the viewport collapses (mobile Safari URL
  // bar, sidebar open/close), and we don't want a stale `isDetached`
  // hiding the pill.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => onScroll();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [onScroll]);

  return {
    scrollRef,
    isDetached,
    scrollToBottom,
    onScroll,
    stickyScrollToBottom,
  };
}
