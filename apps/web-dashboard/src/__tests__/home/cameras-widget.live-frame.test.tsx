/**
 * Home CamerasWidget — the tile shows a real frame, not a mockup.
 *
 * Bug: the widget rendered a hardcoded CSS gradient with an always-on red
 * "rec" dot and a wall-clock timestamp, and never requested an image. On a
 * box with a healthy camera streaming into Frigate, the home tile was still
 * a dark rectangle — the feed had simply never been wired. These tests pin
 * the fix: the tile loads `/api/cameras/:name/snapshot`, and the chrome that
 * implies "live" only renders when something live is actually behind it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { CameraInfo } from "@/lib/types";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/api", () => ({
  getCameraSnapshotUrl: (name: string) => `/api/cameras/${name}/snapshot`,
  // Imported at module scope by other widgets in the same file.
  createVpnPeer: vi.fn(),
  deleteVpnPeer: vi.fn(),
  fetchVpnPeers: vi.fn(),
  fetchVpnStatus: vi.fn(),
}));

let cameras: CameraInfo[] = [];
vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras, totalCameras: cameras.length }),
}));

const cam = (over: Partial<CameraInfo>): CameraInfo =>
  ({
    name: "xnv_c8083r_e43022502afd",
    displayName: "Front Door",
    manufacturer: "Hanwha",
    model: "XNV-C8083R",
    ipAddress: "192.168.9.219",
    macAddress: "E4:30:22:50:2A:FD",
    enabled: true,
    autoDiscovered: true,
    status: "recording",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
    ...over,
  }) as CameraInfo;

/**
 * Stand-in for the offscreen preloader. The widget builds `new window.Image()`,
 * assigns `.src`, and swaps the visible frame in on load — so the test drives
 * whichever callback the scenario needs.
 */
let probes: { src: string; onload?: () => void; onerror?: () => void }[] = [];
class FakeImage {
  onload?: () => void;
  onerror?: () => void;
  #src = "";
  set src(v: string) {
    this.#src = v;
    probes.push(this);
  }
  get src() {
    return this.#src;
  }
}

import { CamerasWidget } from "@/components/home/widgets";

const settleFirstFrame = async () => {
  await waitFor(() => expect(probes.length).toBeGreaterThan(0));
  probes[0].onload?.();
};

describe("Home CamerasWidget live frame", () => {
  beforeEach(() => {
    cleanup();
    probes = [];
    pushMock.mockReset();
    cameras = [cam({})];
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a snapshot for the camera's real name, not its display name", async () => {
    render(<CamerasWidget w={4} h={3} />);

    await waitFor(() => expect(probes.length).toBeGreaterThan(0));
    expect(probes[0].src).toContain(
      "/api/cameras/xnv_c8083r_e43022502afd/snapshot",
    );
  });

  it("paints the decoded frame into the tile", async () => {
    const { container } = render(<CamerasWidget w={4} h={3} />);
    await settleFirstFrame();

    await waitFor(() =>
      expect(container.querySelector(".w-cam img")).not.toBeNull(),
    );
    // Decorative: the tile is a labelled button, so the frame carries alt=""
    // rather than adding a second announced string inside the control.
    const img = container.querySelector(".w-cam img") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toContain(
      "/api/cameras/xnv_c8083r_e43022502afd/snapshot",
    );
  });

  // WARP-1885 (#1519) made the tile tappable. Adding the feed must not
  // regress that — this pins both behaviours to the same element.
  it("keeps the tile a button that opens the Cameras page", async () => {
    render(<CamerasWidget w={4} h={3} />);

    const tile = screen.getByRole("button", {
      name: "Open Front Door in Cameras",
    });
    expect(tile.tagName).toBe("BUTTON");
    fireEvent.click(tile);
    expect(pushMock).toHaveBeenCalledWith("/cameras");
  });

  it("shows no frame and no timestamp until one actually decodes", () => {
    const { container } = render(<CamerasWidget w={4} h={3} />);

    // The pre-fix widget stamped the wall clock on an empty tile.
    expect(container.querySelector(".w-cam img")).toBeNull();
    expect(container.querySelector(".w-cam .ts")).toBeNull();
  });

  it("drops back to the placeholder instead of freezing on a stale frame", async () => {
    const { container } = render(<CamerasWidget w={4} h={3} />);
    await settleFirstFrame();
    await waitFor(() =>
      expect(container.querySelector(".w-cam img")).not.toBeNull(),
    );

    // Feed dies on the next poll.
    await waitFor(() => expect(probes.length).toBeGreaterThan(0));
    probes[probes.length - 1].onerror?.();

    await waitFor(() =>
      expect(container.querySelector(".w-cam img")).toBeNull(),
    );
    expect(container.querySelector(".w-cam .ts")).toBeNull();
  });

  it("never claims 'recording' for an offline camera", async () => {
    cameras = [cam({ status: "offline" })];
    const { container } = render(<CamerasWidget w={4} h={3} />);

    expect(container.querySelector(".w-cam .rec")).toBeNull();
    expect(container.querySelector(".w-cam img")).toBeNull();
    // And it must not poll a camera it knows is down.
    expect(probes.length).toBe(0);
  });

  // The rec dot is the strongest "live" claim in the chrome, so it tracks a
  // frame actually being on screen — not merely "the camera isn't offline".
  // A reverted `!offline` gate fails all three of these.
  it("shows no rec dot for an idle camera before any frame decodes", () => {
    cameras = [cam({ status: "idle" })];
    const { container } = render(<CamerasWidget w={4} h={3} />);

    expect(container.querySelector(".w-cam .rec")).toBeNull();
  });

  it("shows the rec dot only once a frame is actually on screen", async () => {
    const { container } = render(<CamerasWidget w={4} h={3} />);

    // Probe still in flight — nothing live is behind the tile yet.
    expect(container.querySelector(".w-cam .rec")).toBeNull();

    await settleFirstFrame();
    await waitFor(() =>
      expect(container.querySelector(".w-cam .rec")).not.toBeNull(),
    );
  });

  it("drops the rec dot when the snapshot probe starts erroring", async () => {
    const { container } = render(<CamerasWidget w={4} h={3} />);
    await settleFirstFrame();
    await waitFor(() =>
      expect(container.querySelector(".w-cam .rec")).not.toBeNull(),
    );

    // Feed dies on the next poll — the tile is back on the tint placeholder,
    // so the "recording" claim must come down with the frame.
    probes[probes.length - 1].onerror?.();
    await waitFor(() =>
      expect(container.querySelector(".w-cam .rec")).toBeNull(),
    );
  });

  it("keeps tiles distinct when two cameras share a display name", async () => {
    cameras = [
      cam({ name: "cam_a", displayName: "Garage" }),
      cam({ name: "cam_b", displayName: "Garage" }),
    ];
    const { container } = render(<CamerasWidget w={4} h={3} />);

    expect(container.querySelectorAll(".w-cam")).toHaveLength(2);
    await waitFor(() => expect(probes.length).toBeGreaterThanOrEqual(2));
    const requested = probes.map((p) => p.src);
    expect(requested.some((s) => s.includes("/cam_a/snapshot"))).toBe(true);
    expect(requested.some((s) => s.includes("/cam_b/snapshot"))).toBe(true);
  });
});
