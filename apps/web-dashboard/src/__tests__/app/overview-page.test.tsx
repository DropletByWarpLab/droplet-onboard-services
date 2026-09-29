/**
 * WARP-3062 — `/overview` is Home's address under the assistant layout; in
 * every other layout `/` is still Home, so the address forwards there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/app/page", () => ({
  default: () => <div data-testid="home-board" />,
}));

const layoutRef = { current: "assistant" as "sidebar" | "workspace" | "assistant" };
vi.mock("@/lib/nav-layout", () => ({
  useNavLayout: () => ({ layout: layoutRef.current, setLayout: vi.fn() }),
}));

import OverviewPage from "@/app/overview/page";

beforeEach(() => {
  replace.mockClear();
  layoutRef.current = "assistant";
});

describe("/overview", () => {
  it("serves the Home board under the assistant layout", () => {
    render(<OverviewPage />);
    expect(screen.getByTestId("home-board")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["sidebar", "workspace"] as const)(
    "forwards to / under the %s layout, without painting a second Home",
    (layout) => {
      layoutRef.current = layout;
      render(<OverviewPage />);
      expect(screen.queryByTestId("home-board")).toBeNull();
      expect(replace).toHaveBeenCalledWith("/");
    },
  );
});
