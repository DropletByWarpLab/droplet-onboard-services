/**
 * Help search UI (PR #382) — a search box over the local in-repo help index.
 *
 * Extends the existing /help page (browse view + WizardReplay; covered in
 * help.page.test.tsx). New behavior:
 *   1. a search input is present;
 *   2. typing filters the visible topics to matches;
 *   3. a no-match query shows an empty state + an "Ask Droplet AI" affordance;
 *   4. "Ask Droplet AI" hands the query to /chat via the existing
 *      sessionStorage `droplet.pendingPrompt` + router.push("/chat") pattern.
 *
 * Proven RED first: today's /help has no search input, so (1) fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/help",
  useSearchParams: () => new URLSearchParams(),
}));

import HelpPage from "@/app/help/page";

beforeEach(() => {
  pushMock.mockReset();
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/help search (PR #382)", () => {
  it("renders a search input", () => {
    render(<HelpPage />);
    expect(
      screen.getByRole("searchbox", { name: /search help/i }),
    ).toBeInTheDocument();
  });

  it("filters topics to matches as the customer types", () => {
    render(<HelpPage />);
    const box = screen.getByRole("searchbox", { name: /search help/i });
    fireEvent.change(box, { target: { value: "camera" } });

    // The results region shows the cameras topic and hides unrelated ones.
    // Each result is a link whose accessible name leads with the topic title.
    const results = screen.getByRole("region", { name: /search results/i });
    expect(
      within(results).getByRole("link", { name: /cameras/i }),
    ).toBeInTheDocument();
    expect(
      within(results).queryByRole("link", { name: /remote access/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state with Ask Droplet AI on no match", () => {
    render(<HelpPage />);
    const box = screen.getByRole("searchbox", { name: /search help/i });
    fireEvent.change(box, { target: { value: "zzzzz-nope" } });

    expect(screen.getByText(/no results/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /ask droplet ai/i }),
    ).toBeInTheDocument();
  });

  it("hands the query to /chat via pendingPrompt when Ask Droplet AI is clicked", () => {
    render(<HelpPage />);
    const box = screen.getByRole("searchbox", { name: /search help/i });
    fireEvent.change(box, { target: { value: "how do I rotate a vpn key" } });

    fireEvent.click(screen.getByRole("button", { name: /ask droplet ai/i }));

    expect(window.sessionStorage.getItem("droplet.pendingPrompt")).toBe(
      "how do I rotate a vpn key",
    );
    expect(pushMock).toHaveBeenCalledWith("/chat");
  });

  it("still renders the browse view + How Droplet works trigger when the query is empty", () => {
    render(<HelpPage />);
    expect(
      screen.getByRole("button", { name: /how droplet works/i }),
    ).toBeInTheDocument();
    // The full table of contents is present in the browse (unfiltered) view.
    expect(
      screen.getByRole("heading", { level: 1, name: /^help$/i }),
    ).toBeInTheDocument();
  });
});
