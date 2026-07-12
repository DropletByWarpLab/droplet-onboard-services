/**
 * WifiStep — auto-collapse via host topology (WARP-817).
 *
 * WARP-809 shipped the Home Wi-Fi fields behind a manual "Add a Wi-Fi network"
 * disclosure, collapsed by default. The #548 Wi-Fi/address split gave Wi-Fi
 * the whole step to itself and rendered the fields directly instead. WARP-817
 * reintroduces the disclosure, now driven by `getNetworkTopology()`
 * (`@/lib/api`) instead of a static default:
 *
 *   - DOWNSTREAM_ROUTER (the box sits behind an existing home router — the
 *     common case) -> collapsed.
 *   - PRIMARY_ROUTER (the box IS the home's router) -> expanded.
 *   - UNKNOWN, or the read failing (getNetworkTopology() is best-effort —
 *     never throws, resolves null on any error) -> collapsed, the same
 *     degrade-safe default WARP-809 shipped. No regression.
 *
 * The manual disclosure toggle always stays available regardless of posture,
 * and a manual click before the topology fetch resolves is never clobbered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WifiStep } from "./WifiStep";

const getNetworkTopology = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getNetworkTopology: (...a: unknown[]) => getNetworkTopology(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const disclosureButton = () =>
  screen.getByRole("button", { name: /add a wi-?fi network/i });
const ssidInput = () => screen.queryByPlaceholderText(/studio fotonia/i);

describe("WifiStep — topology-driven default (WARP-817)", () => {
  it("collapses by default on DOWNSTREAM_ROUTER (the common case)", async () => {
    getNetworkTopology.mockResolvedValue({ posture: "DOWNSTREAM_ROUTER" });
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(getNetworkTopology).toHaveBeenCalledTimes(1));
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "false");
    expect(ssidInput()).not.toBeInTheDocument();
  });

  it("expands by default on PRIMARY_ROUTER", async () => {
    getNetworkTopology.mockResolvedValue({ posture: "PRIMARY_ROUTER" });
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() =>
      expect(disclosureButton()).toHaveAttribute("aria-expanded", "true"),
    );
    expect(ssidInput()).toBeInTheDocument();
  });

  it("collapses on UNKNOWN posture (never guessed open)", async () => {
    getNetworkTopology.mockResolvedValue({ posture: "UNKNOWN" });
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(getNetworkTopology).toHaveBeenCalledTimes(1));
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "false");
    expect(ssidInput()).not.toBeInTheDocument();
  });

  it("collapses (degrade-safe, no regression) when the topology read fails", async () => {
    // getNetworkTopology() is itself best-effort and never throws — a real
    // failure surfaces as a resolved null, never a rejection.
    getNetworkTopology.mockResolvedValue(null);
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(getNetworkTopology).toHaveBeenCalledTimes(1));
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "false");
    expect(ssidInput()).not.toBeInTheDocument();
  });

  it("keeps the manual disclosure available and functional on a collapsed (DOWNSTREAM) default", async () => {
    getNetworkTopology.mockResolvedValue({ posture: "DOWNSTREAM_ROUTER" });
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(getNetworkTopology).toHaveBeenCalledTimes(1));

    fireEvent.click(disclosureButton());
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "true");
    expect(ssidInput()).toBeInTheDocument();
  });

  it("does not clobber a manual toggle with a late-resolving topology fetch", async () => {
    let resolveTopology!: (v: { posture: string }) => void;
    getNetworkTopology.mockReturnValue(
      new Promise((resolve) => {
        resolveTopology = resolve;
      }),
    );
    render(<WifiStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    // Customer manually opens it before the (slow) topology fetch resolves.
    fireEvent.click(disclosureButton());
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "true");

    // The fetch now resolves DOWNSTREAM_ROUTER (would collapse by default) —
    // the manual toggle must win.
    resolveTopology({ posture: "DOWNSTREAM_ROUTER" });
    await waitFor(() => expect(getNetworkTopology).toHaveBeenCalledTimes(1));
    expect(disclosureButton()).toHaveAttribute("aria-expanded", "true");
    expect(ssidInput()).toBeInTheDocument();
  });
});
