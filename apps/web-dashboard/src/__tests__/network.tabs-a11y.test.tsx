/**
 * WARP-298 — Network tabs WAI-ARIA pattern (source-level pin).
 *
 * The Network page pulls a tower of hooks (useNetwork, useSWR, router,
 * ConfirmDialog…) and rendering it end-to-end requires fixtures that
 * outweigh the value of asserting tab markup. Pin the WAI-ARIA shape
 * via static source inspection — full behaviour for arrow-key nav is
 * exercised on the same code shape under Knowledge tabs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/..."
// on Windows, which path.resolve doubles into "C:\C:\...".
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.resolve(here, "../app/network/page.tsx"),
  "utf-8",
);

describe("Network tabs WAI-ARIA (WARP-298)", () => {
  it("tablist has role and aria-label", () => {
    expect(src).toMatch(/role="tablist"/);
    expect(src).toMatch(/aria-label="Network view tabs"/);
  });

  it("each tab is role=tab with id, aria-selected, aria-controls, tabIndex", () => {
    expect(src).toMatch(/role="tab"/);
    expect(src).toMatch(/id=\{`network-tab-\$\{tab\.id\}`\}/);
    expect(src).toMatch(/aria-selected=\{active\}/);
    expect(src).toMatch(/aria-controls=\{`network-panel-\$\{tab\.id\}`\}/);
    expect(src).toMatch(/tabIndex=\{active \? 0 : -1\}/);
  });

  it("tabpanels carry id + aria-labelledby + tabIndex + hidden", () => {
    expect(src).toMatch(/role="tabpanel"/);
    expect(src).toMatch(/id="network-panel-overview"/);
    expect(src).toMatch(/aria-labelledby="network-tab-overview"/);
    // hidden when inactive — proves all panels mount but only one is shown.
    expect(src).toMatch(/hidden=\{activeTab !== "overview"\}/);
    expect(src).toMatch(/hidden=\{activeTab !== "system"\}/);
  });

  it("Arrow/Home/End keys are handled on tab buttons", () => {
    expect(src).toMatch(/ArrowRight/);
    expect(src).toMatch(/ArrowLeft/);
    expect(src).toMatch(/case "Home"/);
    expect(src).toMatch(/case "End"/);
  });
});

// WARP-100 — tab state lifted to the URL (Option A). These pin the
// URL-integration + reduced-motion scroll without mounting the hook-heavy
// page (same rationale as the source-level a11y pins above).
describe("Network tabs URL integration (WARP-100)", () => {
  it("reads the active tab from useSearchParams (deep-link + back/forward)", () => {
    expect(src).toMatch(/useSearchParams/);
    expect(src).toMatch(/parseNetworkTab\(searchParams\?\.get\("tab"\)\)/);
  });

  it("switching tabs pushes to the router (back returns to prior tab)", () => {
    expect(src).toMatch(/useRouter/);
    expect(src).toMatch(/router\.push\(/);
  });

  // WARP-1723 review finding 2 (third pass): the switcher and networkTabHref
  // built the same URL two different ways. The helper's whole reason to exist
  // is that a cross-surface guarantee shouldn't rest on two literals staying
  // in sync — if they drift, a cross-tab link's href (the middle-click /
  // open-in-new-tab / no-JS path) points somewhere the switcher never
  // produces. One builder, both callers.
  it("builds its own tab URLs with networkTabHref, not an inline ?tab= literal", () => {
    expect(src).toMatch(/router\.push\(networkTabHref\(next\)\)/);
    expect(src).toMatch(/networkTabHref/);
    // No hand-rolled `?tab=${…}` template anywhere in the page.
    expect(src).not.toMatch(/`\/network\?tab=\$\{/);
  });

  it("wraps the page in a Suspense boundary for useSearchParams", () => {
    expect(src).toMatch(/<Suspense/);
  });

  it("cross-tab scroll honours prefers-reduced-motion", () => {
    // Reduced-motion gating now lives in the extracted scroll helper; the page
    // delegates to it. Pin the delegation here and the gating in the helper's
    // own unit suite (schedule-anchor-scroll.test.ts).
    expect(src).toMatch(/scrollToScheduleAnchor/);
  });
});

// WARP-100 PR #720 review — three behavioural fixes, source-pinned because the
// page pulls a tower of hooks and the behaviour is exercised directly in
// schedule-anchor-scroll.test.ts (helper) + DeviceDetailPanel.test.tsx (jump).
describe("Network tabs reactive-hash + a11y fixes (WARP-100 PR #720)", () => {
  it("blocker: re-scrolls on hashchange, not just on tab change", () => {
    // A `hashchange` listener re-fires the bounded retry-scroll so a same-tab /
    // hash-only jump (router.push doesn't fire hashchange, so the DeviceDetail
    // jump dispatches one) still scrolls to the new #schedule-<id>. The listener
    // forwards the event's target hash so it lands on the right row even before
    // router.push commits the live window.location.hash.
    expect(src).toMatch(/addEventListener\("hashchange"/);
    expect(src).toMatch(/removeEventListener\("hashchange"/);
    expect(src).toMatch(/scheduleHashFromEvent\(e\)/);
  });

  it("a11y: arrow-key focus moves AFTER activation, not synchronously", () => {
    // The keydown handler records the target; a post-activation effect keyed on
    // activeTab focuses it once aria-selected/tabIndex reflect the change. The
    // old synchronous getElementById(...).focus() inside the handler is gone.
    expect(src).toMatch(/keyboardFocusTarget\.current = tabs\[next\]\.id/);
    expect(src).toMatch(/keyboardFocusTarget\.current !== activeTab/);
    expect(src).toMatch(
      /document\.getElementById\(`network-tab-\$\{activeTab\}`\)\?\.focus\(\)/,
    );
    // Guard against regressing to the synchronous focus-in-handler pattern.
    expect(src).not.toMatch(
      /getElementById\(`network-tab-\$\{tabs\[next\]\.id\}`\)\s*\n?\s*\?\.focus/,
    );
  });

  it("low: the retry timer is cleaned up (delegated to the helper)", () => {
    // clearTimeout now lives in the helper's returned cleanup; the page calls
    // that cleanup on unmount and on each hashchange before re-arming.
    expect(src).not.toMatch(/setTimeout\(tryScroll, 100\)/);
  });
});

// WARP-1723 (second pass) — a cross-tab link inside a tabpanel is a focus trap
// in reverse: the panels conditionally unmount (`activeTab === "devices" &&
// <DevicesTab />`), so activating the Coverage Extenders panel's "Change in
// Wi-Fi settings" link destroys the focused <a> and focus falls to <body>. A
// keyboard/SR user lands nowhere and has to re-Tab through the whole shell.
// The page already owns the fix — record the arrival tab and let the
// post-activation effect focus it once aria-selected reflects the change.
describe("Network cross-tab link focus (WARP-1723)", () => {
  it("routes the Devices→Wi-Fi link through the page's focus machinery", () => {
    expect(src).toMatch(/onOpenWifiSettings=\{/);
    // Same ref the arrow-key nav uses, so the arrival tab is focused only
    // AFTER it reads aria-selected={true} / tabIndex={0}.
    expect(src).toMatch(/keyboardFocusTarget\.current = "wifi"/);
    expect(src).toMatch(/setActiveTab\("wifi"\)/);
  });
});
