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

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;
const ROOT = path.resolve(here, "..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("WARP-300 DropletMark callsite audit", () => {
  describe("standalone (no nearby wordmark) — opt-in to aria-label", () => {
    it("invite page renders no standalone mark of its own", () => {
      const src = read("app/invite/[token]/page.tsx");
      // The invite page now shares <AuthLayout> with /login, which owns
      // the only mark on the surface (decorative — see below). The page
      // itself must not reintroduce a bare one: any mark it added would
      // be standalone and would need its own aria-label, which is the
      // trap this audit exists to catch.
      expect(src).not.toMatch(/<DropletMark/);
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

    it("auth-layout wordmark mark is decorative (wordmark adjacent)", () => {
      // The aurora re-skin pairs the compact mark with a visible
      // "Droplet" wordmark span — default aria-hidden is correct;
      // announcing the SVG would duplicate the wordmark. The mark moved
      // out of the login page into <AuthLayout>, the shared shell behind
      // BOTH /login and /invite/[token], so this one assertion now covers
      // every public auth surface.
      const src = read("components/auth/AuthLayout.tsx");
      expect(src).toMatch(
        /<DropletMark size=\{24\} className="text-accent" \/>/,
      );
      expect(src).not.toMatch(/<DropletMark[^>]*aria-label/);
    });

    it("login page delegates its mark to AuthLayout", () => {
      // Guards the delegation itself: if /login ever re-adds its own
      // mark it would sit alongside AuthLayout's, duplicating the logo.
      const src = read("app/login/page.tsx");
      expect(src).not.toMatch(/<DropletMark/);
      expect(src).toMatch(/<AuthLayout/);
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
