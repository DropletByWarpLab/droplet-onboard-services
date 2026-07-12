/**
 * Wi-Fi step — fits the panel without an inner scroll cap.
 *
 * WARP-847: the onboarding split (#548) wrapped this fixed-content form (SSID +
 * password fields, security chip, advisory notices, help card) in a
 * <ScrollRegion> capped at `max-h-[40dvh] sm:max-h-[44dvh]`, regressing the
 * #546 fix — an inner scrollbar over the inputs, a clipped help card, and dead
 * space below the card. The form is fixed-content (not an unbounded list), so
 * it renders directly; the StepShell content panel is scroll-when-needed
 * instead, exactly like OrgStep / StorageStep after #546.
 *
 * jsdom can't measure layout, so these are STRUCTURE assertions: every field —
 * down to the bottom-most help card — renders and is reachable, and the form
 * is NOT trapped inside a height-capped scroll region.
 *
 * WARP-817 reintroduced a topology-driven "Add a Wi-Fi network" disclosure
 * (collapsed by default — see WifiStep.test.tsx / WifiStep.topology.test.tsx),
 * so these structure assertions open it first; the scroll-cap property under
 * test is about the panel once the fields ARE on screen, same as before.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WifiStep } from "./WifiStep";

function openWifiDisclosure() {
  fireEvent.click(screen.getByRole("button", { name: /add a wi-?fi network/i }));
}

describe("WifiStep fits without an inner scroll cap", () => {
  it("renders the Wi-Fi form directly, not inside a height-capped scroll region", () => {
    render(<WifiStep onComplete={() => {}} onSkip={() => {}} />);
    openWifiDisclosure();

    // The form's top field renders…
    expect(screen.getByPlaceholderText("Studio Fotonia")).toBeInTheDocument();

    // …and it is NOT wrapped in the old bounded scroll region (no dvh cap).
    expect(
      screen.queryByRole("region", { name: /home wi-?fi setup/i }),
    ).toBeNull();
  });

  it("keeps the bottom-most security chip and help card reachable (not clipped)", () => {
    render(<WifiStep onComplete={() => {}} onSkip={() => {}} />);
    openWifiDisclosure();

    // The WPA2/WPA3 chip and the help card are the lowest content — the bits
    // that used to clip behind the inner scrollbar — so they must still render.
    expect(screen.getByText(/wpa2 \/ wpa3/i)).toBeInTheDocument();
    expect(screen.getByText(/how does this work\?/i)).toBeInTheDocument();
  });
});
