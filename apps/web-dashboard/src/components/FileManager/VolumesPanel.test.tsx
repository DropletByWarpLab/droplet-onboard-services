/**
 * WARP-1337 — Volumes tiles on the main Files screen must show the
 * customer-facing name, never a GUID mount tail.
 *
 * Root cause: VolumesPanel named tiles from "label || mount-tail" and never
 * consulted `displayName` — the customer name the orchestrator already joins
 * onto every /api/storage/drives entry — so a pool mounted at
 * /mnt/droplet/<full-fs-uuid> rendered its raw GUID. Drift-guard: both the
 * happy path (displayName wins) and the fallback (GUID is NEVER the title)
 * are pinned here; the chain itself lives in the shared drive-display helper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DriveInfo } from "@/lib/types";

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));

import { VolumesPanel } from "./VolumesPanel";

const GUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sdb1",
    mount: `/mnt/droplet/${GUID}`,
    label: "",
    uuid: "U-1",
    size_bytes: 2_000_000_000_000,
    used_bytes: 100_000_000_000,
    free_bytes: 1_900_000_000_000,
    mounted: true,
    displayName: null,
    ...overrides,
  };
}

function setup(drives: DriveInfo[]) {
  useDrivesMock.mockReturnValue({
    drives,
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
  return render(<VolumesPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VolumesPanel — customer-facing names (WARP-1337 AC2)", () => {
  it("titles the tile with the customer's displayName, not the GUID mount tail", () => {
    setup([makeDrive({ displayName: "Family Photos" })]);
    expect(screen.getByText("Family Photos")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(GUID.slice(0, 8), "i"))).not.toBeInTheDocument();
  });

  it("never renders a raw GUID as the tile title when no name exists", () => {
    setup([makeDrive()]);
    // The generic friendly fallback — never the machine id.
    expect(screen.getByText("Drive")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(GUID.slice(0, 8), "i"))).not.toBeInTheDocument();
    // Not even via the title attribute on the name span.
    expect(document.querySelector(`[title*="${GUID.slice(0, 8)}"]`)).toBeNull();
  });

  it("says 'Storage pool' for a nameless pool-backed volume", () => {
    setup([makeDrive({ device: "/dev/md127p1" })]);
    expect(screen.getByText("Storage pool")).toBeInTheDocument();
  });

  it("still falls back to the FS label before the mount tail", () => {
    setup([makeDrive({ label: "TOSHIBA EXT" })]);
    expect(screen.getByText("TOSHIBA EXT")).toBeInTheDocument();
  });
});
