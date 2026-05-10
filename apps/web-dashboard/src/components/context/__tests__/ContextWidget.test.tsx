/**
 * WARP-225 — ContextWidget smoke test.
 *
 * Mocks the SWR hook to feed canned summary shapes and asserts the
 * tile renders the right counts, status pill, and never-spinning
 * skeleton path.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Override the global setup's broken Link stub with a passthrough that
// renders children as a real anchor — needed so getByRole("button"),
// findByText etc. can traverse into the children of <Link>.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import { ContextWidget } from "../ContextWidget";

const mockHook = vi.fn();
vi.mock("@/lib/hooks/useContextStats", () => ({
  useContextStatsSummary: () => mockHook(),
}));

// framer-motion's animate uses requestAnimationFrame which jsdom emits;
// we just need the counter to render its initial number synchronously.
describe("<ContextWidget />", () => {
  it("renders a skeleton on first paint without crashing", () => {
    mockHook.mockReturnValue({
      summary: null,
      isLoading: true,
      error: undefined,
    });
    const { container } = render(<ContextWidget />);
    // skeleton bars use animate-pulse class
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("renders an error fallback tile (never throws)", () => {
    mockHook.mockReturnValue({
      summary: null,
      isLoading: false,
      error: new Error("nope"),
    });
    render(<ContextWidget />);
    expect(screen.getByText(/Couldn't reach/i)).toBeInTheDocument();
  });

  it("renders counts + 'All ready' pill when no queued/failed", () => {
    mockHook.mockReturnValue({
      summary: {
        files: 847,
        chunks: 142309,
        queued: 0,
        failed: 0,
        recentlyIndexed: [],
      },
      isLoading: false,
      error: undefined,
    });
    render(<ContextWidget />);
    expect(screen.getByText(/files indexed/i)).toBeInTheDocument();
    expect(screen.getByText(/chunks searchable/i)).toBeInTheDocument();
    expect(screen.getByText(/All ready/i)).toBeInTheDocument();
  });

  it("renders amber + red counts when queued/failed > 0", () => {
    mockHook.mockReturnValue({
      summary: {
        files: 5,
        chunks: 12,
        queued: 2,
        failed: 1,
        recentlyIndexed: [],
      },
      isLoading: false,
      error: undefined,
    });
    render(<ContextWidget />);
    expect(screen.getByText(/2 queued/i)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/i)).toBeInTheDocument();
  });
});
