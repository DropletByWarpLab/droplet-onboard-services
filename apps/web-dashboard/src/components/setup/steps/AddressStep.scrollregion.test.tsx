/**
 * Internet-address step — fits the panel without an inner scroll cap.
 *
 * WARP-847: the onboarding split (#548) wrapped this fixed-content body (chain
 * diagram, subdomain + token fields, auto-update toggle, help card) in a
 * <ScrollRegion> capped at `max-h-[40dvh] sm:max-h-[44dvh]`, regressing the
 * #546 fix — an inner scrollbar over the inputs, a clipped help card, and dead
 * space below the card. The body is fixed-content (not an unbounded list), so
 * it renders directly; the StepShell content panel is scroll-when-needed
 * instead, exactly like OrgStep / StorageStep after #546.
 *
 * STRUCTURE assertions (jsdom can't measure layout): the chain diagram and
 * every field — down to the bottom-most help card — render and are reachable,
 * and the body is NOT trapped inside a height-capped scroll region.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // The step loads any prior DuckDNS config on mount; render unconfigured.
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  };
});

import { AddressStep } from "./AddressStep";

/** The mount-time DuckDNS load disables the primary CTA until it settles —
 *  wait it out so assertions run on the loaded form (and no act() noise). */
async function renderLoaded() {
  render(<AddressStep onComplete={() => {}} onSkip={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled(),
  );
}

describe("AddressStep fits without an inner scroll cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the address form directly, not inside a height-capped scroll region", async () => {
    await renderLoaded();

    // The chain diagram and the form's top field render…
    expect(
      screen.getByRole("img", {
        name: /home wi-fi, then internet address \(this step\)/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("yourstudio")).toBeInTheDocument();

    // …and the body is NOT wrapped in the old bounded scroll region (no dvh cap).
    expect(
      screen.queryByRole("region", { name: /internet address setup/i }),
    ).toBeNull();
  });

  it("keeps the bottom-most auto-update toggle and help card reachable (not clipped)", async () => {
    await renderLoaded();

    // The auto-update checkbox and the help card are the lowest content — the
    // bits that used to clip behind the inner scrollbar — so they must render.
    expect(
      screen.getByRole("checkbox", {
        name: /keep the address up to date automatically/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/how does this work\?/i)).toBeInTheDocument();
  });
});
