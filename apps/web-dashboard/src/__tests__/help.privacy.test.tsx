/**
 * WARP-914 — the WelcomeStep "Learn more" link deep-links to /help#privacy,
 * so /help MUST carry a `privacy` section that explains what Droplet is, that
 * the AI runs locally on the customer's own hardware, and how privacy works.
 *
 * A missing section here is a dead "Learn more" link (the welcome page would
 * land the customer at the top of /help instead of the privacy topic they
 * tapped).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import HelpPage from "@/app/help/page";
import { HELP_INDEX } from "@/lib/help-index";

describe("/help privacy section (WARP-914)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("explains Droplet, local AI, and privacy in the section body", () => {
    render(<HelpPage />);
    // eslint-disable-next-line testing-library/no-node-access
    const section = document.getElementById("privacy");
    const text = (section?.textContent ?? "").toLowerCase();
    // What Droplet is + the local-AI guarantee + the privacy promise.
    expect(text).toContain("droplet");
    expect(text).toMatch(/runs (locally|on your)/);
    expect(text).toContain("hardware");
    expect(text).toMatch(/(never leave|stays on|nothing leaves)/);
  });

  it("carries a searchable help-index entry for the privacy topic", () => {
    expect(HELP_INDEX.some((e) => e.id === "privacy")).toBe(true);
  });
});
