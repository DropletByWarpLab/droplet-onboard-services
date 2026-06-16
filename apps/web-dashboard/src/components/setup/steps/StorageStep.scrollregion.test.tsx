/**
 * Storage step — fits the panel without an inner scroll cap.
 *
 * WARP-820 wrapped this fixed-content body (drive cards + optional RAID/Adopt
 * sections + help card) in a <ScrollRegion> capped at `max-h-[44dvh]`, which
 * forced an inner scrollbar on desktop with empty space below. The body is
 * fixed-content (not an unbounded list), so it no longer uses a ScrollRegion;
 * the StepShell content panel is scroll-when-needed instead. The two destructive
 * ConfirmDialog overlays remain portaled modals, outside the flow.
 *
 * STRUCTURE assertions (jsdom can't measure layout): the drive cards and the
 * RAID toggle render and are reachable, and the body is NOT trapped in a
 * height-capped scroll region.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const FIXTURE_DRIVES = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/data",
      label: "TOSHIBA EXT",
      uuid: "UUID-MAIN",
      size_bytes: 2_000_000_000_000,
      used_bytes: 100_000_000_000,
      free_bytes: 1_900_000_000_000,
      mounted: true,
      displayName: null,
    },
    {
      device: "/dev/sda2",
      mount: "/mnt/droplet/nvr",
      label: "WD ELEMENTS",
      uuid: "UUID-NVR",
      size_bytes: 1_000_000_000_000,
      used_bytes: 0,
      free_bytes: 1_000_000_000_000,
      mounted: true,
      displayName: null,
    },
  ],
  count: 2,
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDrives: vi.fn(async () => FIXTURE_DRIVES),
  };
});

import { StorageStep } from "./StorageStep";

describe("StorageStep fits without an inner scroll cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the drive cards directly, not inside a height-capped scroll region", async () => {
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);

    // The detected-drive card renders…
    await waitFor(() =>
      expect(screen.getByText("TOSHIBA EXT")).toBeInTheDocument(),
    );

    // …and the body is NOT wrapped in the old bounded scroll region (no 44dvh cap).
    expect(
      screen.queryByRole("region", { name: /storage options/i }),
    ).toBeNull();
  });

  it("keeps the optional RAID pool toggle reachable (not clipped)", async () => {
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: /set up a storage pool/i }),
      ).toBeInTheDocument(),
    );
  });
});
