import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mark next/link's output so the test can tell a client-side route from a
// plain anchor (the global setup mock renders a string template instead).
vi.mock("next/link", () => ({
  default: ({ children, ...props }: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("a", { ...props, "data-next-link": "" }, children);
  },
}));

import { ChatMessage } from "@/components/ChatMessage";

function renderAnswer(content: string) {
  render(<ChatMessage message={{ id: "a1", role: "assistant", content }} />);
}

describe("ChatMessage — in-app links (WARP-3116)", () => {
  it("routes a dashboard path client-side", () => {
    renderAnswer("Opening [Voice](/voice).");
    const link = screen.getByRole("link", { name: "Voice" });
    expect(link).toHaveAttribute("href", "/voice");
    expect(link).toHaveAttribute("data-next-link");
  });

  // WARP-3193 SEC-INJ-1: any link that is not a dashboard page keeps the
  // hardened SafeLink rendering — new tab, no Referer, no window.opener.
  it("keeps an external link on the hardened SafeLink renderer", () => {
    renderAnswer("See [the docs](https://example.com/docs).");
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).not.toHaveAttribute("data-next-link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("opens a same-origin /api/ link (a camera snapshot) in a new tab, not client-side", () => {
    renderAnswer("[Snapshot](/api/cameras/porch/snapshot)");
    const link = screen.getByRole("link", { name: "Snapshot" });
    expect(link).toHaveAttribute("href", "/api/cameras/porch/snapshot");
    expect(link).not.toHaveAttribute("data-next-link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not treat an authority-leading path as in-app", () => {
    renderAnswer("[odd](/..//evil.example)");
    const link = screen.getByRole("link", { name: "odd" });
    expect(link).not.toHaveAttribute("data-next-link");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
