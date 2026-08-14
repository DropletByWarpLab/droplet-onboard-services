/**
 * WARP-1726 — the Devices grid must not collapse while it is still loading.
 *
 * Two things made the reload loop violent rather than merely annoying. The
 * empty state was gated on SWR's `isLoading`, which is true only for the very
 * FIRST request of a key — so the moment a cold load failed (a 401 during a
 * token rotation) or a retry started, the tab asserted "Your router hasn't seen
 * any devices yet" about a network full of devices. And the loading state was a
 * bare centred spinner, so the page briefly became a few hundred pixels tall;
 * the browser then clamped the restored scroll offset to the bottom of that
 * short page, which is the "scroll jumps to the bottom" half of the report.
 *
 * Same fixture shape as network.device-search-empty.test.tsx: only the two data
 * hooks matter, so the grid sections and coverage panel are stubbed out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useNetworkDevicesMock = vi.fn();
const useNetworkGroupsMock = vi.fn();

vi.mock("@/lib/hooks/useNetworkDevices", () => ({
  useNetworkDevices: (...a: any[]) => useNetworkDevicesMock(...a),
}));
vi.mock("@/lib/hooks/useNetworkGroups", () => ({
  useNetworkGroups: (...a: any[]) => useNetworkGroupsMock(...a),
}));
vi.mock("@/components/network/CoverageExtendersPanel", () => ({
  CoverageExtendersPanel: () => null,
}));
vi.mock("@/components/network/DeviceGridSection", () => ({
  DeviceGridSection: () => <div data-testid="device-grid" />,
}));

import { DevicesTab } from "@/components/network/DevicesTab";

const EMPTY_STATE_COPY = /hasn['’]t seen any devices yet/i;

beforeEach(() => {
  useNetworkDevicesMock.mockReset();
  useNetworkGroupsMock.mockReset();
  useNetworkGroupsMock.mockReturnValue({ data: { groups: [] }, mutate: vi.fn() });
});

describe("Devices tab — no false empty state while loading (WARP-1726)", () => {
  it("hides the empty state during the first load", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.queryByText(EMPTY_STATE_COPY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // The regression that actually bit: SWR reports `isLoading` for the first
  // request only. A retry after a failed cold load is `isValidating` with no
  // data — which read as "loaded, and there are zero devices".
  it("hides the empty state while a retry is in flight with no data yet", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: true,
      error: new Error("401"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.queryByText(EMPTY_STATE_COPY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("reserves a stable height while loading so the page cannot collapse", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    const skeleton = screen.getByRole("status");
    expect(parseInt(skeleton.style.minHeight, 10)).toBeGreaterThanOrEqual(300);
  });

  it("still shows the empty state once a response confirms zero devices", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: { devices: [] },
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByText(EMPTY_STATE_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // A load that failed and is NOT being retried keeps its existing fallback —
  // the card with the Retry affordance — rather than rendering nothing at all,
  // which would collapse the page even harder than the state we are fixing.
  it("keeps a retry affordance when a failed load has settled", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: false,
      error: new Error("500"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

/**
 * WARP-1726 (second pass) — the empty state must not take the blame for a
 * failure it didn't cause.
 *
 * Between poll ticks of a failed cold load the grid settled on "Your router
 * hasn't seen any devices yet" — a confident, specific claim about the ROUTER,
 * made while the tab had in fact never heard back from the orchestrator (an
 * expired access token, a box mid-reboot). That sentence is the founder's
 * reported symptom, "shows no devices", stated in the app's own voice. The tab
 * had the evidence to know better all along: it simply never read
 * `devicesSwr.error`.
 */
describe("Devices tab — a failed load says so, honestly (WARP-1726)", () => {
  const failedColdLoad = {
    data: undefined,
    isLoading: false,
    isValidating: false,
    error: new Error("401"),
  };

  it("does not blame the router when the load itself failed", () => {
    useNetworkDevicesMock.mockReturnValue({ ...failedColdLoad, mutate: vi.fn() });

    render(<DevicesTab />);

    expect(screen.queryByText(EMPTY_STATE_COPY)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn['’]t load your devices/i)).toBeInTheDocument();
  });

  it("reassures the user their devices still exist, and offers the retry", () => {
    const mutate = vi.fn();
    useNetworkDevicesMock.mockReturnValue({ ...failedColdLoad, mutate });

    render(<DevicesTab />);

    expect(screen.getByText(/your devices are still there/i)).toBeInTheDocument();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(mutate).toHaveBeenCalled();
  });

  // Design-system copy rules: sentence case, no exclamation marks, and no raw
  // status codes or transport jargon on a home-user surface.
  it("keeps the copy calm and free of error codes", () => {
    useNetworkDevicesMock.mockReturnValue({ ...failedColdLoad, mutate: vi.fn() });

    const { container } = render(<DevicesTab />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/\b401\b|\b500\b|\bError\b/);
  });

  // The distinction that makes this honest in BOTH directions: a response that
  // genuinely carried zero devices is still the router's story to tell.
  it("still blames nobody but the router when the response really was empty", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: { devices: [] },
      isLoading: false,
      isValidating: false,
      error: undefined,
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByText(EMPTY_STATE_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/couldn['’]t load your devices/i)).not.toBeInTheDocument();
  });

  // A poll that fails AFTER a good load must not replace a screen full of
  // devices with an error card — SWR keeps serving the last good data, and the
  // next tick usually repairs it silently.
  it("keeps showing known devices when a later poll fails", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: {
        devices: [
          {
            mac: "aa:bb:cc:dd:ee:ff",
            displayName: "Kitchen iPad",
            hostname: "ipad",
            vendor: "Apple",
            lastIp: "192.168.1.20",
            lastSeen: new Date().toISOString(),
            online: true,
            groups: [],
            isAccessPoint: false,
          },
        ],
      },
      isLoading: false,
      isValidating: false,
      error: new Error("503"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByTestId("device-grid")).toBeInTheDocument();
    expect(screen.queryByText(/couldn['’]t load your devices/i)).not.toBeInTheDocument();
  });

  // A failure that is already being retried keeps the loading state — the
  // reserved-height skeleton — rather than flashing an error card at every tick.
  it("prefers the loading state while a retry is already in flight", () => {
    useNetworkDevicesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isValidating: true,
      error: new Error("401"),
      mutate: vi.fn(),
    });

    render(<DevicesTab />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(/couldn['’]t load your devices/i)).not.toBeInTheDocument();
  });
});
