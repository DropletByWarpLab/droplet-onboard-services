/**
 * Internet step — fits the panel without an inner scroll cap.
 *
 * WARP-820 wrapped this fixed-content network form in a <ScrollRegion> capped at
 * `max-h-[44dvh]`, which forced an inner scrollbar on desktop with empty space
 * below. The form is fixed-content (not an unbounded list), so it no longer uses
 * a ScrollRegion; the StepShell content panel is scroll-when-needed instead.
 *
 * STRUCTURE assertions (jsdom can't measure layout): the form fields — including
 * the optional Home Wi-Fi disclosure and the DuckDNS field — render and are
 * reachable, and the body is NOT trapped in a height-capped scroll region.
 *
 * NOTE: the WARP-808 / WARP-809 Wi-Fi write behaviour is untouched and is
 * covered by InternetStep.test.tsx / InternetStep.hostapd-warning.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  };
});

import { InternetStep } from "./InternetStep";

describe("InternetStep fits without an inner scroll cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the network form directly, not inside a height-capped scroll region", async () => {
    render(<InternetStep onComplete={() => {}} onSkip={() => {}} />);

    // The DuckDNS subdomain field renders…
    await waitFor(() =>
      expect(screen.getByPlaceholderText("yourstudio")).toBeInTheDocument(),
    );

    // …and the body is NOT wrapped in the old bounded scroll region (no 44dvh cap).
    expect(
      screen.queryByRole("region", { name: /network setup/i }),
    ).toBeNull();
  });

  it("keeps the optional Home Wi-Fi disclosure reachable (not clipped)", async () => {
    render(<InternetStep onComplete={() => {}} onSkip={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add a wi-fi network/i }),
      ).toBeInTheDocument(),
    );
  });
});
