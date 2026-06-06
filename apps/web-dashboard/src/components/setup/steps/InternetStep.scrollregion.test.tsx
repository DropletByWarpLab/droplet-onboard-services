/**
 * WARP-820 (review finding #3) — InternetStep's body (the optional Home Wi-Fi
 * disclosure, the DuckDNS subdomain + token fields, the auto-update checkbox,
 * any notice, and the help card) is taller than a short landscape phone
 * (~568px), and the setup panel is now `overflow-hidden`. Without a scroll
 * surface the DuckDNS token field + help card clip off the bottom. The body
 * therefore lives inside a <ScrollRegion> — the wizard's single permitted scroll
 * surface — so it scrolls within the panel instead of clipping. Title + CTA stay
 * pinned in the StepShell.
 *
 * Structure assertion (jsdom can't measure scroll): the form fields render
 * INSIDE the labelled scroll region, and that region carries the bounded-scroll
 * classes. Mirrors DiscoveryStep/TeamStep.scrollregion.test.tsx.
 *
 * NOTE: this only adds a scroll wrapper around the EXISTING body — the WARP-808 /
 * WARP-809 Wi-Fi write behaviour is untouched and is covered by
 * InternetStep.test.tsx / InternetStep.hostapd-warning.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  };
});

import { InternetStep } from "./InternetStep";

describe("InternetStep body in ScrollRegion (WARP-820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the network form inside a bounded, labelled scroll region", async () => {
    render(<InternetStep onComplete={() => {}} onSkip={() => {}} />);

    const region = await screen.findByRole("region", {
      name: /network setup/i,
    });
    // The DuckDNS subdomain field lives in the form body.
    await waitFor(() =>
      expect(
        within(region).getByPlaceholderText("yourstudio"),
      ).toBeInTheDocument(),
    );

    // …and the region is the bounded-scroll surface.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });

  it("keeps the optional Home Wi-Fi disclosure reachable inside the scroll region", async () => {
    render(<InternetStep onComplete={() => {}} onSkip={() => {}} />);

    const region = await screen.findByRole("region", {
      name: /network setup/i,
    });
    // The "Add a Wi-Fi network" disclosure toggle is part of the scrollable body.
    expect(
      within(region).getByRole("button", { name: /add a wi-fi network/i }),
    ).toBeInTheDocument();
  });
});
