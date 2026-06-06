/**
 * WARP-820 (review finding #3) — StorageStep's body (drive cards + the optional
 * RAID pool section + the "reclaim drives" section + the help card) is taller
 * than a short landscape phone (~568px), and the setup panel is now
 * `overflow-hidden`. Without a scroll surface the RAID/Adopt UI clips off the
 * bottom with no way to reach it. The body therefore lives inside a
 * <ScrollRegion> — the wizard's single permitted scroll surface — so it scrolls
 * within the panel instead of clipping. Title + CTA stay pinned in the
 * StepShell.
 *
 * Structure assertion (jsdom can't measure scroll): the drive cards render
 * INSIDE the labelled scroll region, and that region carries the
 * bounded-scroll classes. Mirrors DiscoveryStep/TeamStep.scrollregion.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

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

describe("StorageStep body in ScrollRegion (WARP-820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the drive cards inside a bounded, labelled scroll region", async () => {
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);

    // The detected-drive card lands inside the labelled scroll region.
    const region = await screen.findByRole("region", {
      name: /storage options/i,
    });
    expect(within(region).getByText("TOSHIBA EXT")).toBeInTheDocument();

    // …and the region is the bounded-scroll surface.
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toContain("overscroll-contain");
    expect(region.className).toMatch(/max-h-\[[^\]]*(vh|dvh|svh)\]/);
  });

  it("keeps the optional RAID pool toggle reachable inside the scroll region", async () => {
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);

    const region = await screen.findByRole("region", {
      name: /storage options/i,
    });
    // The RAID section is the content most at risk of clipping on a short
    // viewport; it must be inside the scrollable region.
    await waitFor(() =>
      expect(
        within(region).getByRole("switch", {
          name: /set up a storage pool/i,
        }),
      ).toBeInTheDocument(),
    );
  });
});
