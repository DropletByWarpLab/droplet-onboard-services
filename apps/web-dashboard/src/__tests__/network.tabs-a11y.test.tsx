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

  it("wraps the page in a Suspense boundary for useSearchParams", () => {
    expect(src).toMatch(/<Suspense/);
  });

  it("cross-tab scroll honours prefers-reduced-motion", () => {
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
    expect(src).toMatch(/reduceMotion \? "auto" : "smooth"/);
  });
});
