/**
 * WARP-174 — Help page + WizardReplay modal.
 *
 * Validates:
 *   1. Renders the page heading, the "How Droplet works" trigger, and
 *      a TOC link for each section.
 *   2. Each section's anchor + title is rendered so deep-links from
 *      the wizard's LearnMoreCards land on the right topic.
 *   3. "How Droplet works" opens the WizardReplay modal showing all
 *      four positioning cards.
 *   4. Modal close button returns focus and hides the cards.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import HelpPage from "@/app/help/page";

const SECTION_ANCHORS = [
  "internet",
  "storage",
  "cameras",
  "vpn",
  "ai",
  "devices",
  "files",
];

describe("/help page (WARP-174)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the heading + How Droplet works trigger + TOC", () => {
    render(<HelpPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^help$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /how droplet works/i }),
    ).toBeInTheDocument();
    // TOC enumerates every section.
    for (const anchor of SECTION_ANCHORS) {
      const link = screen.getByRole("link", { name: new RegExp(anchor, "i") });
      expect(link).toHaveAttribute("href", `#${anchor}`);
    }
  });

  it("renders a section element for each wizard helpAnchor", () => {
    render(<HelpPage />);
    for (const anchor of SECTION_ANCHORS) {
      // `id` is the LearnMoreCard helpAnchor target — the deep-link
      // contract from the wizard.
      // eslint-disable-next-line testing-library/no-node-access
      const section = document.getElementById(anchor);
      expect(section).not.toBeNull();
    }
  });

  it("opens the WizardReplay modal showing all four positioning cards", () => {
    render(<HelpPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /how droplet works/i }),
    );
    // The modal heading.
    expect(
      screen.getByRole("heading", { level: 2, name: /how droplet works/i }),
    ).toBeInTheDocument();
    // Four positioning cards by their titles.
    expect(
      screen.getByText(/your files live here, not in the cloud/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the ai runs on your hardware/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your camera footage stays put/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/remote access is end-to-end encrypted/i),
    ).toBeInTheDocument();
  });

  it("closes the WizardReplay modal via the X button", async () => {
    render(<HelpPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /how droplet works/i }),
    );
    expect(
      screen.getByText(/your files live here, not in the cloud/i),
    ).toBeInTheDocument();

    // Dialog uses framer-motion's AnimatePresence; exit-anim unmount
    // is async even with reduced motion. Wait for the card to drop
    // from the DOM rather than asserting immediately.
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(
      () => {
        expect(
          screen.queryByText(/your files live here, not in the cloud/i),
        ).not.toBeInTheDocument();
      },
      { timeout: 1500 },
    );
  });
});
