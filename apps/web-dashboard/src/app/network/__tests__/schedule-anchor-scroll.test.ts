// WARP-100 follow-up (PR #720 review) — unit tests for the extracted
// schedule-anchor scroll helper. The Network page is hook-heavy, so the
// retry-scroll trigger is pulled out into a pure function we can drive with
// jsdom + fake timers. This pins:
//   • Blocker — the scroll re-fires for whatever `#schedule-<id>` the hash
//     currently points at (not just on tab change), and the row is scrolled +
//     focused.
//   • Low — the bounded retry's setTimeout id is cleared on cleanup so no
//     queued timers fire after teardown.
//   • reduced-motion gating and the 20×100ms bounded retry are preserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scrollToScheduleAnchor,
  scheduleHashFromEvent,
} from "../schedule-anchor-scroll";

function makeRow(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  // jsdom has no layout engine — stub the methods the helper calls so we can
  // assert they were invoked.
  el.scrollIntoView = vi.fn();
  el.focus = vi.fn();
  document.body.appendChild(el);
  return el;
}

// Assigning `window.location.hash` makes jsdom run a session-history
// navigation, which itself calls setTimeout and explodes under fake timers.
// history.replaceState updates location.hash without that navigation, so it's
// safe to call while fake timers are installed. Pass "" to clear the hash.
function setHash(hash: string) {
  window.history.replaceState(null, "", hash || "/network");
}

describe("scrollToScheduleAnchor (WARP-100 PR #720)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setHash("");
    // Default: motion allowed (matches: false). Individual tests override.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("never scrolls when the hash isn't a #schedule- anchor, and returns a callable cleanup", () => {
    const row = makeRow("schedule-abc");
    setHash("#not-a-schedule");
    const cleanup = scrollToScheduleAnchor();
    // A non-schedule hash must not scroll any schedule row, and cleanup must
    // always be callable (it may have armed a self-correcting retry).
    expect(row.scrollIntoView).not.toHaveBeenCalled();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("targets the explicit targetHash over the live hash (router.push hash not yet committed)", () => {
    // The live hash still points at the old anchor (router.push hasn't
    // committed the new one), but the caller passes the intended target — we
    // must scroll the explicit one, NOT the stale live-hash row.
    setHash("#schedule-old");
    const oldRow = makeRow("schedule-old");
    const newRow = makeRow("schedule-new");

    scrollToScheduleAnchor("#schedule-new");

    expect(newRow.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(oldRow.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls + focuses the row matching the CURRENT hash (same-tab/hash-only jump)", () => {
    const row = makeRow("schedule-abc");
    setHash("#schedule-abc");

    scrollToScheduleAnchor();

    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(row.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth", block: "start" }),
    );
    expect(row.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("targets the row named by the NEW hash, even if a different row exists", () => {
    makeRow("schedule-old");
    const fresh = makeRow("schedule-new");
    setHash("#schedule-new");

    scrollToScheduleAnchor();

    expect(fresh.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("uses behavior:auto (instant) when prefers-reduced-motion is set", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, // reduce
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const row = makeRow("schedule-rm");
    setHash("#schedule-rm");

    scrollToScheduleAnchor();

    expect(row.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
  });

  it("retries on a 100ms timer while the row is absent, then scrolls once it appears", () => {
    vi.useFakeTimers();
    setHash("#schedule-late");

    scrollToScheduleAnchor();

    // No row yet — nothing to scroll.
    vi.advanceTimersByTime(100);
    // Row mounts after a couple of ticks (simulates SchedulesTab SWR resolving).
    const row = makeRow("schedule-late");
    vi.advanceTimersByTime(100);

    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded retry budget (~2s, ≤21 lookups)", () => {
    vi.useFakeTimers();
    // Count lookups via getElementById — one per attempt — rather than
    // setTimeout (which jsdom's own internals also call). The row never
    // appears, so every attempt misses and reschedules until the bound.
    const lookupSpy = vi.spyOn(document, "getElementById");
    setHash("#schedule-never");

    scrollToScheduleAnchor();
    // Drive well past the 2s budget.
    vi.advanceTimersByTime(5_000);

    // Bounded: 1 immediate attempt + at most 20 retries = 21 lookups, never
    // an unbounded spin.
    expect(lookupSpy.mock.calls.length).toBeLessThanOrEqual(21);
    expect(lookupSpy.mock.calls.length).toBeGreaterThan(1); // it did retry
  });

  it("clears the pending retry timer on cleanup (no timers fire after teardown)", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    setHash("#schedule-pending");

    const cleanup = scrollToScheduleAnchor(); // queues the first 100ms retry
    cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalled();

    // After cleanup, even if the row appears, no scroll happens — the loop
    // was cancelled AND its timer cleared.
    const row = makeRow("schedule-pending");
    vi.advanceTimersByTime(5_000);
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("scheduleHashFromEvent (WARP-100 PR #720)", () => {
  it("extracts a #schedule- fragment from the event's newURL", () => {
    const e = new HashChangeEvent("hashchange", {
      newURL: "http://localhost/network?tab=schedules#schedule-s1",
    });
    expect(scheduleHashFromEvent(e)).toBe("#schedule-s1");
  });

  it("returns undefined for a non-schedule fragment (caller falls back to live hash)", () => {
    const e = new HashChangeEvent("hashchange", {
      newURL: "http://localhost/network#something-else",
    });
    expect(scheduleHashFromEvent(e)).toBeUndefined();
  });

  it("returns undefined when newURL is empty (native synthetic dispatch w/o detail)", () => {
    const e = new HashChangeEvent("hashchange");
    expect(scheduleHashFromEvent(e)).toBeUndefined();
  });
});
