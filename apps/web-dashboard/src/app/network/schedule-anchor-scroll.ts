// WARP-100 — scroll a cross-tab/deep-link `#schedule-<id>` anchor into view.
//
// Extracted from page.tsx (PR #720 review) so it can be:
//   • unit-tested without mounting the hook-heavy Network page, and
//   • re-invoked on `hashchange` — the page effect was keyed on `activeTab`,
//     so a second jump while already on the Schedules tab (the tab doesn't
//     change, only the hash) never re-fired and the row never scrolled.
//
// The caller may pass an explicit `targetHash`. App Router's router.push
// commits history.pushState (which updates window.location.hash) a tick AFTER
// the call, so the same-tab jump dispatches a synthetic hashchange carrying the
// intended hash in `newURL`; the page forwards it here so we target the right
// row regardless of whether the live hash has committed yet. When omitted (the
// mount / tab-switch / browser back-forward path) we read window.location.hash.
//
// The anchor only exists after SchedulesTab renders its list (SWR resolves
// async), so it polls briefly for the anchor (20 × 100ms ≈ 2s) then gives up.
// Honours prefers-reduced-motion. Returns a cleanup that cancels the loop AND
// clears the pending retry timer so no queued ticks fire after teardown.

export function scrollToScheduleAnchor(targetHash?: string): () => void {
  if (typeof window === "undefined") return () => {};
  const hash = targetHash ?? window.location.hash;
  if (!hash.startsWith("#schedule-")) return () => {};
  const id = hash.slice(1); // drop leading '#'

  // Honour prefers-reduced-motion: the CSS global block doesn't override a
  // programmatic scrollIntoView({behavior:"smooth"}), so gate it here —
  // reduced-motion users get an instant jump instead of an animated scroll.
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let cancelled = false;
  let attempts = 0;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const tryScroll = () => {
    if (cancelled) return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      // Land keyboard focus on the row (instant :focus ring — no timed
      // flash). preventScroll avoids fighting the scrollIntoView above.
      // Clean up the temporary tabindex on blur so we don't leave stray
      // focusable artifacts across repeated jumps.
      if (el instanceof HTMLElement) {
        el.setAttribute("tabindex", "-1");
        el.addEventListener(
          "blur",
          () => el.removeAttribute("tabindex"),
          { once: true },
        );
        el.focus({ preventScroll: true });
      }
      return;
    }
    // Anchor not in the DOM yet (SchedulesTab still loading) — retry for
    // ~2s (20 × 100ms) then give up rather than spin forever.
    if (attempts++ < 20) timerId = setTimeout(tryScroll, 100);
  };
  tryScroll();

  return () => {
    cancelled = true;
    if (timerId !== undefined) clearTimeout(timerId);
  };
}

// Extract a `#schedule-<id>` fragment from a hashchange event's `newURL`
// (populated on native back/forward and on the synthetic event the
// DeviceDetailPanel jump dispatches). Returns undefined when there's no usable
// fragment, so the caller falls back to window.location.hash.
export function scheduleHashFromEvent(e: HashChangeEvent): string | undefined {
  if (!e.newURL) return undefined;
  const idx = e.newURL.indexOf("#");
  if (idx === -1) return undefined;
  const frag = e.newURL.slice(idx);
  return frag.startsWith("#schedule-") ? frag : undefined;
}
