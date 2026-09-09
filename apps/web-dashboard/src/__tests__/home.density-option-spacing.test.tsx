/**
 * WARP-1899 — density options: title must not render flush against its
 * description.
 *
 * The Settings → Display density popup rendered each option as
 * "BalancedComfortable spacing. The default view." — `.dh-opt-txt` is a
 * <span> wrapper whose `.t` / `.d` children are inline spans, and the rule
 * carried `flex: 1; min-width: 0` but never `display: flex;
 * flex-direction: column`, so both spans sat on one line and the
 * description's `margin-top` was inert.
 *
 * Two halves, matching the repo's CSS-contract precedent
 * (home.hero-focus.test.tsx):
 *  1. Render: the modal really produces separate `.t` / `.d` elements inside
 *     a `.dh-opt-txt` wrapper for every option — the DOM the stylesheet rule
 *     keys on.
 *  2. Stylesheet guard: `.dh-opt-txt` stacks its children as a column and
 *     `.dh-opt-txt .d` keeps a top margin — jsdom does not apply external
 *     stylesheets, so the spacing contract is asserted at the source. Remove
 *     the column stacking and this goes red.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", displayName: "Alice" } }),
}));
vi.mock("@/lib/hooks/useBoxAddress", () => ({
  useBoxAddress: () => "droplet.local",
}));
vi.mock("@/lib/api", () => ({ fetchSystemHealth: vi.fn() }));
vi.mock("@/components/home/AmbientLayer", () => ({ AmbientLayer: () => null }));
vi.mock("@/components/home/BentoBoard", () => ({ BentoBoard: () => null }));
vi.mock("@/components/home/bento-engine", () => ({
  fillGaps: (items: unknown[]) => items,
}));
vi.mock("@/components/home/widgets", () => ({
  WIDGETS: { chat: { Comp: () => null, icon: () => null, title: "Chat" } },
  CATALOG: [],
}));

import DashboardPage from "@/app/page";

// jsdom has no matchMedia; the page's useIsMobile needs one. matches:false
// keeps the desktop rendering (the surface QA reported against).
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

/** label → description copy for the three density options. */
const OPTIONS: Array<[string, string]> = [
  ["Balanced", "Comfortable spacing. The default view."],
  ["Dense", "Tighter grid — more on screen at once."],
  ["Airy", "Generous spacing — calmer, larger cards."],
];

describe("WARP-1899 density option title/description spacing", () => {
  it("each option renders title and description as separate elements inside .dh-opt-txt", () => {
    render(<DashboardPage />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const group = screen.getByRole("radiogroup", { name: "Display density" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(OPTIONS.length);

    OPTIONS.forEach(([label, desc], i) => {
      const wrap = radios[i].querySelector(".dh-opt-txt");
      expect(wrap, `${label}: .dh-opt-txt wrapper`).not.toBeNull();
      const t = wrap!.querySelector(".t");
      const d = wrap!.querySelector(".d");
      expect(t?.textContent).toBe(label);
      expect(d?.textContent).toBe(desc);
      // Separate sibling elements — not one concatenated text node.
      expect(t).not.toBe(d);
      expect(t!.parentElement).toBe(wrap);
      expect(d!.parentElement).toBe(wrap);
    });
  });

  it(".dh-opt-txt stacks title over description with spacing (home-bento.css)", () => {
    // `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
    // src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
    const here = __dirname;
    const css = readFileSync(
      path.resolve(here, "../components/home/home-bento.css"),
      "utf-8",
    );

    // The wrapper itself must be a column flex container — as a plain inline
    // wrapper its two spans render flush on one line.
    const wrapRule = css.match(/\.dh-opt-txt\s*\{([^}]*)\}/);
    expect(wrapRule, ".dh-opt-txt rule exists").not.toBeNull();
    expect(wrapRule![1]).toMatch(/display:\s*flex/);
    expect(wrapRule![1]).toMatch(/flex-direction:\s*column/);

    // And the description keeps its breathing room off the title.
    const descRule = css.match(/\.dh-opt-txt \.d\s*\{([^}]*)\}/);
    expect(descRule, ".dh-opt-txt .d rule exists").not.toBeNull();
    expect(descRule![1]).toMatch(/margin-top:\s*[1-9]/);
  });
});
