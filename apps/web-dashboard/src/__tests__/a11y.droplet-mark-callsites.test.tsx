/**
 * WARP-300 — DropletMark callsite audit.
 *
 * WARP-298 made <DropletMark> opt-in: the SVG defaults to
 * `aria-hidden="true"` so it never duplicates a nearby "Droplet"
 * wordmark, and callers who use it standalone (no nearby text saying
 * "Droplet") must pass `aria-label="Droplet"` to make the mark
 * announced as a logo.
 *
 * This audit fixes the callsites as the invariants below so any new
 * placement has to make the decorative-vs-standalone call explicitly.
 *
 * Source-level checks (no render harness) — matches the WARP-298
 * pattern in `a11y.icon-button-labels.test.tsx`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `new URL(...).pathname` — the latter yields "/C:/..."
// on Windows, which path.resolve doubles into "C:\C:\...".
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("WARP-300 DropletMark callsite audit", () => {
  describe("standalone (no nearby wordmark) — opt-in to aria-label", () => {
    it("invite page loading-state mark is standalone and announces", () => {
      const src = read("app/invite/[token]/page.tsx");
      // Loading state mark sits next to "Loading your invitation..." —
      // no "Droplet" word adjacent, so the mark must self-label.
      expect(src).toMatch(
        /<DropletMark size=\{40\} className="text-accent mx-auto mb-4" aria-label="Droplet"/,
      );
    });

    it("invite page header mark is standalone and announces", () => {
      const src = read("app/invite/[token]/page.tsx");
      // The header mark sits in its own div above the heading and has
      // no adjacent "Droplet" wordmark — opt-in to aria-label.
      expect(src).toMatch(
        /<DropletMark size=\{40\} className="text-accent" aria-label="Droplet"/,
      );
    });

    it("AuthGate loading-state mark is standalone and announces", () => {
      const src = read("components/AuthGate.tsx");
      // Loading state shows "Loading..." next to the mark — no
      // "Droplet" wordmark adjacent. Opt-in to aria-label. (WARP-1079:
      // the class moved to the GATE_BRAND_TEXT lockstep constant; the
      // aria-label invariant is what this audit protects.)
      expect(src).toMatch(
        /<DropletMark size=\{32\} className=\{GATE_BRAND_TEXT\} aria-label="Droplet"/,
      );
    });
  });

  describe("decorative (visible 'Droplet' text adjacent) — default aria-hidden", () => {
    it("Sidebar mark is decorative (wordmark adjacent)", () => {
      // <DropletMark> sits next to <span>Droplet</span> in the sidebar
      // logo. Default aria-hidden is correct — announcing the SVG
      // would duplicate the wordmark.
      const src = read("components/Sidebar.tsx");
      expect(src).toMatch(
        /<DropletMark size=\{22\} className="text-accent" \/>/,
      );
    });

    it("login wordmark mark is decorative (wordmark adjacent)", () => {
      // The aurora re-skin pairs the compact mark with a visible
      // "Droplet" wordmark span — default aria-hidden is correct;
      // announcing the SVG would duplicate the wordmark.
      const src = read("app/login/page.tsx");
      expect(src).toMatch(
        /<DropletMark size=\{24\} className="text-accent" \/>/,
      );
      expect(src).not.toMatch(/<DropletMark[^>]*aria-label/);
    });

    it("setup welcome mark is decorative (heading adjacent)", () => {
      // The welcome step (extracted to WelcomeStep in the aurora
      // re-skin) titles itself "Welcome to Droplet" next to the mark
      // — decorative.
      const src = read("components/setup/steps/WelcomeStep.tsx");
      expect(src).toMatch(
        /<DropletMark size=\{34\} className="text-white" \/>/,
      );
    });

    it("WelcomeFlourish mark is decorative (status-role parent + heading)", () => {
      // The flourish lives inside a role="status" parent that animates
      // a heading conveying the welcome context; the mark itself is
      // decorative.
      const src = read("components/auth/WelcomeFlourish.tsx");
      expect(src).toMatch(
        /<DropletMark size=\{56\} className="text-accent" \/>/,
      );
    });
  });
});
