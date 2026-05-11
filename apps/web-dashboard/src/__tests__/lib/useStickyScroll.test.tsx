import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useStickyScroll, STICKY_PX } from "@/lib/hooks/useStickyScroll";

/**
 * jsdom doesn't drive layout, so `scrollHeight` / `clientHeight` / `scrollTop`
 * are 0 by default. The Probe component sets them imperatively to exercise
 * the sticky-detach logic.
 */

interface Captured {
  isDetached: boolean;
  scrollToBottom: () => void;
  onScroll: () => void;
  stickyScrollToBottom: () => void;
  el: HTMLDivElement | null;
}

function Probe({
  scrollHeight,
  clientHeight,
  scrollTop,
  onValue,
  messagesDep,
}: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  onValue: (v: Captured) => void;
  messagesDep?: number;
}) {
  const { scrollRef, isDetached, scrollToBottom, onScroll, stickyScrollToBottom } =
    useStickyScroll();

  // Stamp layout values onto the underlying div ONCE so jsdom (which
  // doesn't run layout) reads stable scrollHeight/clientHeight. After
  // mount, scrollTop is mutated by the hook under test — defining it
  // every render would clobber that mutation.
  const stampedRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stampedRef.current) {
      Object.defineProperty(el, "scrollHeight", {
        value: scrollHeight,
        configurable: true,
      });
      Object.defineProperty(el, "clientHeight", {
        value: clientHeight,
        configurable: true,
      });
      Object.defineProperty(el, "scrollTop", {
        value: scrollTop,
        writable: true,
        configurable: true,
      });
      stampedRef.current = true;
    }
    onValue({
      isDetached,
      scrollToBottom,
      onScroll,
      stickyScrollToBottom,
      el,
    });
  });

  // Run sticky-scroll on every messagesDep change so callers can verify
  // the "auto-scroll iff attached" behavior.
  useEffect(() => {
    stickyScrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesDep]);

  return (
    <div
      ref={scrollRef}
      data-testid="scroll-container"
      onScroll={onScroll}
    />
  );
}

describe("useStickyScroll (WARP-295)", () => {
  let captured: Captured | null = null;

  beforeEach(() => {
    captured = null;
  });

  afterEach(() => {
    captured = null;
  });

  it("reports isDetached=false when the user is at the bottom", () => {
    // 1000 - 1000 - 0 = 0 < 80 → attached.
    render(
      <Probe
        scrollHeight={1000}
        clientHeight={1000}
        scrollTop={0}
        onValue={(v) => (captured = v)}
      />,
    );
    act(() => captured!.onScroll());
    expect(captured!.isDetached).toBe(false);
  });

  it("reports isDetached=true when the user has scrolled up past the threshold", () => {
    // scrollHeight=2000, clientHeight=500, scrollTop=1000
    // 2000 - 1000 - 500 = 500 ≥ 80 → detached.
    render(
      <Probe
        scrollHeight={2000}
        clientHeight={500}
        scrollTop={1000}
        onValue={(v) => (captured = v)}
      />,
    );
    act(() => captured!.onScroll());
    expect(captured!.isDetached).toBe(true);
  });

  it("treats scrolling within STICKY_PX of bottom as 'still attached'", () => {
    // gap = 79px (< 80) → attached.
    const gap = STICKY_PX - 1;
    render(
      <Probe
        scrollHeight={1000}
        clientHeight={500}
        scrollTop={500 - gap}
        onValue={(v) => (captured = v)}
      />,
    );
    act(() => captured!.onScroll());
    expect(captured!.isDetached).toBe(false);
  });

  it("scrollToBottom() sets scrollTop to scrollHeight and flips isDetached back to false", () => {
    render(
      <Probe
        scrollHeight={2000}
        clientHeight={500}
        scrollTop={1000}
        onValue={(v) => (captured = v)}
      />,
    );
    act(() => captured!.onScroll());
    expect(captured!.isDetached).toBe(true);

    act(() => captured!.scrollToBottom());
    expect(captured!.el!.scrollTop).toBe(2000);
    expect(captured!.isDetached).toBe(false);
  });

  it("stickyScrollToBottom() scrolls when attached", () => {
    render(
      <Probe
        scrollHeight={1000}
        clientHeight={1000}
        scrollTop={0}
        onValue={(v) => (captured = v)}
        messagesDep={1}
      />,
    );
    // The effect already ran stickyScrollToBottom once on mount; the
    // attached probe should have its scrollTop pinned to scrollHeight.
    expect(captured!.el!.scrollTop).toBe(1000);
  });

  it("stickyScrollToBottom() does NOT scroll when the user has detached", () => {
    render(
      <Probe
        scrollHeight={2000}
        clientHeight={500}
        scrollTop={1000}
        onValue={(v) => (captured = v)}
        messagesDep={1}
      />,
    );
    // After mount, the user is detached; sticky-scroll must NOT have
    // yanked them to the bottom.
    expect(captured!.el!.scrollTop).toBe(1000);
  });
});
