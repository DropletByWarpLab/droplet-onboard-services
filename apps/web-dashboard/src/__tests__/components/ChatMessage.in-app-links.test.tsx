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

  it("leaves an external link a plain anchor, exactly as before", () => {
    renderAnswer("See [the docs](https://example.com/docs).");
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).not.toHaveAttribute("data-next-link");
  });

  it("does not treat an authority-leading path as in-app", () => {
    renderAnswer("[odd](/..//evil.example)");
    expect(screen.getByRole("link", { name: "odd" })).not.toHaveAttribute("data-next-link");
  });
});
