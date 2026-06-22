/**
 * RadioDetailCard — read-only "Wireless radio" detail, honest for the
 * single-box single-host-radio shape.
 *
 * No fabricated literals: every chip is backed by a real iwinfo field or shows
 * "not reported". The Broadcasting/Disabled chip is derived from real state, not
 * hardcoded. There is NO enable/disable toggle (one combined host radio that
 * can't be turned off independently). The mt76 TX-cap note shows ONLY when a
 * genuinely low txpower is read, never unconditionally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchRadioDetail: vi.fn(),
}));

import { fetchRadioDetail } from "@/lib/api";
import { RadioDetailCard } from "../RadioDetailCard";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RadioDetailCard />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RadioDetailCard", () => {
  it("shows real iwinfo chips + a Broadcasting chip when the radio is up", async () => {
    asMock(fetchRadioDetail).mockResolvedValue({
      supported: false,
      hostRadio: true,
      broadcasting: true,
      channel: 6,
      htmode: "HT20",
      txpower: 20,
      country: "US",
      mode: "Master",
    });
    renderCard();
    await waitFor(() => expect(screen.getByText("Broadcasting")).toBeTruthy());
    expect(screen.getByText(/channel 6/i)).toBeTruthy();
    expect(screen.getByText("HT20")).toBeTruthy();
    expect(screen.getByText("US")).toBeTruthy();
    // The single combined-radio honest note, and NO enable/disable toggle.
    expect(screen.getByText(/one combined Wi-Fi radio/i)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders 'not reported' for fields iwinfo omits, never a fabricated value", async () => {
    asMock(fetchRadioDetail).mockResolvedValue({
      supported: false,
      hostRadio: true,
      broadcasting: true,
      channel: 6,
      htmode: null,
      txpower: null,
      country: null,
      mode: "Master",
    });
    renderCard();
    await waitFor(() => expect(screen.getByText(/channel 6/i)).toBeTruthy());
    expect(screen.getAllByText(/not reported/i).length).toBeGreaterThan(0);
  });

  it("hides the TX-power cap note when txpower is normal", async () => {
    asMock(fetchRadioDetail).mockResolvedValue({
      supported: false,
      hostRadio: true,
      broadcasting: true,
      channel: 6,
      htmode: "HT20",
      txpower: 20,
      country: "US",
      mode: "Master",
    });
    renderCard();
    await waitFor(() => expect(screen.getByText("Broadcasting")).toBeTruthy());
    expect(screen.queryByText(/transmit power is capped/i)).toBeNull();
  });

  it("shows the TX-power cap note only when txpower is at/below the cap", async () => {
    asMock(fetchRadioDetail).mockResolvedValue({
      supported: false,
      hostRadio: true,
      broadcasting: true,
      channel: 6,
      htmode: "HT20",
      txpower: 3,
      country: "US",
      mode: "Master",
    });
    renderCard();
    await waitFor(() => expect(screen.getByText(/transmit power is capped/i)).toBeTruthy());
  });

  it("shows a Disabled chip when the radio isn't broadcasting", async () => {
    asMock(fetchRadioDetail).mockResolvedValue({
      supported: false,
      hostRadio: true,
      broadcasting: false,
      channel: null,
      htmode: null,
      txpower: null,
      country: null,
      mode: null,
    });
    renderCard();
    await waitFor(() => expect(screen.getByText("Not broadcasting")).toBeTruthy());
  });
});
