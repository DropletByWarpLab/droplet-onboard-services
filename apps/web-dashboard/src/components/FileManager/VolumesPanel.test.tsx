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
import type { DriveInfo, PoolInfo } from "@/lib/types";

// next/link → plain anchor so we can assert href without a Next router
// (same shape as DrivesPanel.test.tsx).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));

// WARP-1339: the panel now consumes pools too, to merge the mounted md
// filesystem into ONE pooled tile instead of an anonymous GUID drive tile.
const usePoolsMock = vi.fn();
vi.mock("@/lib/hooks/usePools", () => ({ usePools: () => usePoolsMock() }));

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

function setup(drives: DriveInfo[], pools: PoolInfo[] = []) {
  useDrivesMock.mockReturnValue({
    drives,
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
  usePoolsMock.mockReturnValue({
    pools,
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

// =====================================================================
// WARP-1339 — the main Files screen renders ONE tile per pool (the merge
// shape was previously tested nowhere): the mounted md filesystem's bytes
// under the pool's name, with the plain tiles keeping only standalone
// drives. Tiles stay non-clickable in this PR — WARP-1338 adds links.
// =====================================================================
describe("VolumesPanel — one pooled tile (WARP-1339 AC3)", () => {
  const TIB = 1024 ** 4;
  const pool: PoolInfo = {
    device: "md127",
    level: "raid1",
    status: "active",
    members: ["sdb", "sdc"],
    displayName: null,
    notes: null,
  };
  const mdDrive = () =>
    makeDrive({
      device: "/dev/md127",
      pool: "md127",
      mount: `/mnt/droplet/${GUID}`,
      label: "",
      uuid: "U-POOL-FS",
      size_bytes: 4 * TIB,
      used_bytes: 1 * TIB,
      free_bytes: 3 * TIB,
    });

  it("renders ONE 'Storage pool' tile with the md filesystem's bytes — GUID never rendered", () => {
    setup([mdDrive()], [pool]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Storage pool")).toBeInTheDocument();
    // Real fs-level bytes from the matched md drive (ADR-019).
    expect(screen.getByText("3.0 TB free")).toBeInTheDocument();
    expect(screen.getByText("1.0 TB")).toBeInTheDocument();
    expect(screen.getByText(/of 4\.0 TB/)).toBeInTheDocument();
    // The GUID never leaks — not as text, not via the title attribute.
    expect(screen.queryByText(new RegExp(GUID.slice(0, 8), "i"))).not.toBeInTheDocument();
    expect(document.querySelector(`[title*="${GUID.slice(0, 8)}"]`)).toBeNull();
  });

  it("titles the pooled tile with the owner's pool displayName when set", () => {
    setup([mdDrive()], [{ ...pool, displayName: "Family Vault" }]);
    expect(screen.getByText("Family Vault")).toBeInTheDocument();
    expect(screen.queryByText("Storage pool")).not.toBeInTheDocument();
  });

  it("makes the pooled tile clickable into the file browser at the md mount tail (WARP-1338)", () => {
    setup([mdDrive()], [pool]);
    const link = screen.getByRole("link", { name: /open storage pool/i });
    expect(link).toHaveAttribute(
      "href",
      `/files?path=${encodeURIComponent(`/${GUID}`)}`,
    );
  });

  it("keeps standalone drives as plain tiles alongside the pooled tile", () => {
    setup(
      [
        mdDrive(),
        makeDrive({
          device: "/dev/sda1",
          uuid: "U-2",
          mount: "/mnt/droplet/photos",
          displayName: "Family Photos",
        }),
      ],
      [pool],
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Family Photos")).toBeInTheDocument();
    expect(screen.getByText("Storage pool")).toBeInTheDocument();
  });

  it("falls back to a plain (GUID-guarded) drive tile when the pools payload lacks the pool", () => {
    // Degraded /storage/pools fetch: dropping the drive with no pool tile to
    // merge into would lose the volume from the Files screen entirely.
    setup([mdDrive()], []);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Storage pool")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(GUID.slice(0, 8), "i"))).not.toBeInTheDocument();
  });
});

// =====================================================================
// WARP-1338 — the tiles become CLICKABLE: a stretched link into the file
// browser at /files?path=/<mount-tail> (the Nextcloud external-storage
// path the automount/pool registration created), via the shared
// driveContentsHref helper. Stretched-link pattern: the anchor overlays
// the whole card — never a button nested inside an anchor.
// =====================================================================
describe("VolumesPanel — clickable tiles (WARP-1338)", () => {
  it("links a standalone drive tile to /files?path=/<mount-tail>", () => {
    setup([
      makeDrive({
        mount: "/mnt/droplet/photos-ab12cd34",
        displayName: "Family Photos",
      }),
    ]);
    const link = screen.getByRole("link", { name: /open family photos/i });
    expect(link).toHaveAttribute("href", "/files?path=%2Fphotos-ab12cd34");
  });

  it("gives every tile exactly one link and nests no interactive controls inside it", () => {
    setup(
      [
        makeDrive({
          device: "/dev/sda1",
          uuid: "U-2",
          mount: "/mnt/droplet/photos",
          displayName: "Family Photos",
        }),
      ],
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // Stretched-link hygiene: never nest buttons (or nested anchors) inside.
    expect(document.querySelector("a button")).toBeNull();
    expect(document.querySelector("a a")).toBeNull();
  });

  it("stretches the link across the card (absolute inset overlay on a relative card)", () => {
    setup([makeDrive({ displayName: "Family Photos" })]);
    const link = screen.getByRole("link", { name: /open family photos/i });
    expect(link.className).toMatch(/absolute/);
    expect(link.className).toMatch(/inset-0/);
    const card = screen.getByRole("listitem");
    expect(card.className).toMatch(/relative/);
  });
});

/**
 * WARP-1876 — "there's a large empty region to the right of the Nvr
 * storage card". The grid reserved three columns at xl regardless of how
 * many volumes exist, so a box with one drive rendered a card and two
 * columns of nothing. Columns are capped at the tile count.
 */
describe("VolumesPanel — the grid never reserves empty columns (WARP-1876)", () => {
  function gridOf(): HTMLElement {
    return screen.getByRole("list", { name: "Storage volumes" });
  }

  it("stays single-column for a single volume", () => {
    useDrivesMock.mockReturnValue({
      drives: [makeDrive({ displayName: "Nvr" })],
      isLoading: false,
      bridgeError: null,
    });
    usePoolsMock.mockReturnValue({ pools: [] });
    render(<VolumesPanel />);

    const cls = gridOf().className;
    expect(cls).not.toMatch(/sm:grid-cols-2/);
    expect(cls).not.toMatch(/xl:grid-cols-3/);
  });

  it("goes to two columns for two volumes, never three", () => {
    useDrivesMock.mockReturnValue({
      drives: [
        makeDrive({ displayName: "Nvr", device: "/dev/sdb1", mount: "/mnt/a" }),
        makeDrive({ displayName: "Media", device: "/dev/sdc1", mount: "/mnt/b" }),
      ],
      isLoading: false,
      bridgeError: null,
    });
    usePoolsMock.mockReturnValue({ pools: [] });
    render(<VolumesPanel />);

    const cls = gridOf().className;
    expect(cls).toMatch(/sm:grid-cols-2/);
    expect(cls).not.toMatch(/xl:grid-cols-3/);
  });

  it("uses the full three columns once there are three volumes", () => {
    useDrivesMock.mockReturnValue({
      drives: [
        makeDrive({ displayName: "Nvr", device: "/dev/sdb1", mount: "/mnt/a" }),
        makeDrive({ displayName: "Media", device: "/dev/sdc1", mount: "/mnt/b" }),
        makeDrive({ displayName: "Backups", device: "/dev/sdd1", mount: "/mnt/c" }),
      ],
      isLoading: false,
      bridgeError: null,
    });
    usePoolsMock.mockReturnValue({ pools: [] });
    render(<VolumesPanel />);

    expect(gridOf().className).toMatch(/xl:grid-cols-3/);
  });
});
