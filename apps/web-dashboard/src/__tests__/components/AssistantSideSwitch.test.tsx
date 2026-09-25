/**
 * WARP-3062 — the "Ask AI | Overview" switch: a two-tab tablist whose tabs
 * are links, selected by the side the route belongs to, operable from the
 * keyboard with manual activation (arrows move focus; Enter / Space open).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The global setup mocks next/link as a string; the switch needs real
// anchors (ref, role, key handlers) to be queried and focused.
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

import { AssistantSideSwitch } from "@/components/assistant/AssistantSideSwitch";

const hrefs = { ask: "/chat?c=abc", business: "/customers/42" };

beforeEach(() => {
  push.mockClear();
});

describe("AssistantSideSwitch", () => {
  it("is one tablist of two link tabs, in the nav's own words", () => {
    render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    const list = screen.getByRole("tablist", { name: "Ask AI or Overview" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(list).toContainElement(tabs[0]);
    expect(tabs.map((t) => t.textContent)).toEqual(["Ask AI", "Overview"]);
    expect(tabs[0].tagName).toBe("A");
  });

  it("each tab leads to the last place used on its side", () => {
    render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    expect(screen.getByRole("tab", { name: "Ask AI" })).toHaveAttribute("href", "/chat?c=abc");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("href", "/customers/42");
  });

  it("selects the side it is given, and only that one is in the tab order", () => {
    const { rerender } = render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    const ask = screen.getByRole("tab", { name: "Ask AI" });
    const overview = screen.getByRole("tab", { name: "Overview" });
    expect(ask).toHaveAttribute("aria-selected", "true");
    expect(ask).toHaveAttribute("tabindex", "0");
    expect(overview).toHaveAttribute("aria-selected", "false");
    expect(overview).toHaveAttribute("tabindex", "-1");

    rerender(<AssistantSideSwitch side="business" hrefs={hrefs} />);
    expect(ask).toHaveAttribute("aria-selected", "false");
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(overview).toHaveAttribute("tabindex", "0");
  });

  it("gives the selected side more than one cue: the thumb's position and a heavier glyph", () => {
    const { container, rerender } = render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("data-side", "ask");
    expect(container.querySelector(".da-thumb")).toHaveAttribute("aria-hidden", "true");
    const strokeOf = (name: string) =>
      screen.getByRole("tab", { name }).querySelector("svg")?.getAttribute("stroke-width");
    expect(strokeOf("Ask AI")).toBe("2");
    expect(strokeOf("Overview")).toBe("1.5");

    rerender(<AssistantSideSwitch side="business" hrefs={hrefs} />);
    expect(list).toHaveAttribute("data-side", "business");
    expect(strokeOf("Ask AI")).toBe("1.5");
    expect(strokeOf("Overview")).toBe("2");
  });

  it("arrow keys move focus across the switch without leaving the page", () => {
    render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    const ask = screen.getByRole("tab", { name: "Ask AI" });
    const overview = screen.getByRole("tab", { name: "Overview" });
    ask.focus();
    fireEvent.keyDown(ask, { key: "ArrowRight" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(ask).toHaveFocus();
    fireEvent.keyDown(ask, { key: "ArrowLeft" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "Home" });
    expect(ask).toHaveFocus();
    fireEvent.keyDown(ask, { key: "End" });
    expect(overview).toHaveFocus();
    expect(push).not.toHaveBeenCalled();
  });

  it("Space opens the focused side", () => {
    render(<AssistantSideSwitch side="ask" hrefs={hrefs} />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: " " });
    expect(push).toHaveBeenCalledWith("/customers/42");
  });
});
