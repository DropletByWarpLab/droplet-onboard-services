/**
 * Web-address step — fits the panel without an inner scroll cap.
 *
 * WARP-847: the onboarding split (#548) wrapped this fixed-content body in a
 * <ScrollRegion> capped at `max-h-[40dvh] sm:max-h-[44dvh]`, regressing the
 * #546 fix — an inner scrollbar, a clipped help card, and dead space below the
 * card. The body is fixed-content (chain diagram, address card, help card), so
 * it renders directly; the StepShell content panel is scroll-when-needed
 * instead, exactly like OrgStep / StorageStep after #546.
 *
 * STRUCTURE assertions (jsdom can't measure layout): the chain diagram and the
 * bottom-most help card render and are reachable, and the body is NOT trapped
 * inside a height-capped scroll region.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // The step reads the box's web address on mount; render an unconfigured box.
    fetchVpnStatus: vi.fn(async () => ({
      configured: true,
      endpointConfigured: true,
    })),
  };
});

import { AddressStep } from "./AddressStep";

async function renderStep() {
  render(<AddressStep onComplete={() => {}} onSkip={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeEnabled(),
  );
}

describe("AddressStep fits without an inner scroll cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the body directly, not inside a height-capped scroll region", async () => {
    await renderStep();

    // The chain diagram renders…
    expect(
      screen.getByRole("img", {
        name: /home wi-fi, then web address \(this step\)/i,
      }),
    ).toBeInTheDocument();

    // …and the body is NOT wrapped in the old bounded scroll region (no dvh cap).
    expect(
      screen.queryByRole("region", { name: /web address setup/i }),
    ).toBeNull();
  });

  it("keeps the bottom-most help card reachable (not clipped)", async () => {
    await renderStep();

    // The help card is the lowest content — the bit that used to clip behind the
    // inner scrollbar — so it must render.
    expect(screen.getByText(/how does this work\?/i)).toBeInTheDocument();
  });
});
