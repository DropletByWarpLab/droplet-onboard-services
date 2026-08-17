/**
 * WARP-1992 — the Overview Activity widget links out to /reports.
 *
 * Overview answers "what's happening now"; Reports answers "how did it go",
 * and it reads the real signed activity chain — which this widget does not.
 * Without this link the new surface has no entry point from the landing page
 * except the sidebar.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// next/link → plain anchor. The global stub in setup.ts stringifies children
// and renders no <a>, so a link assertion would fail against a real link.
// Same per-file override drives-panel.pools.test.tsx uses.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { ActivityWidget } from "@/components/home/widgets";

afterEach(cleanup);

describe("Overview Activity widget → /reports (WARP-1992)", () => {
  it("renders a real anchor to /reports, not an inert div", () => {
    render(<ActivityWidget />);
    const link = screen.getByRole("link", { name: /full report/i });
    expect(link.getAttribute("href")).toBe("/reports");
  });

  it("puts the link after the events, so it reads as the way out and not a header", () => {
    const { container } = render(<ActivityWidget />);
    const rows = Array.from(container.querySelectorAll(".timeline-row"));
    const link = container.querySelector(".timeline-more")!;
    expect(rows.length).toBeGreaterThan(0);
    // compareDocumentPosition: FOLLOWING === 4 — the link comes after the last row.
    expect(rows[rows.length - 1].compareDocumentPosition(link) & 4).toBe(4);
  });

  it("is the widget's only outbound link — one way out, not a menu", () => {
    const { container } = render(<ActivityWidget />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});
