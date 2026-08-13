/**
 * Home CamerasWidget — the frame is shown whole, at the camera's own shape.
 *
 * ── The defect ──────────────────────────────────────────────────────────
 * WARP-1911 wired a real frame into the home tile, but the tile kept the
 * shape of whatever slot the bento handed it: `.w-cams` stretched each tile
 * to a full grid row, and the frame was painted `object-fit: cover`. A single
 * camera in a two-column grid therefore got a tall, half-width box — and
 * `cover` filled it by scaling a 16:9 frame up until a narrow vertical strip
 * of the scene covered the box, cropping most of the picture away and
 * smearing what was left. Reported from the phone board, where the tile is
 * tallest relative to its width.
 *
 * ── The fix, in three parts ─────────────────────────────────────────────
 *   1. The tile carries the decoded frame's OWN aspect ratio (inline, from
 *      `naturalWidth/naturalHeight`), with 16/9 as the CSS placeholder until
 *      a frame lands. Cameras are not all 16:9.
 *   2. `.w-cams` centres its tiles instead of stretching them, so the tile
 *      keeps that ratio in a tall widget rather than being handed a portrait
 *      box to fill.
 *   3. The frame paints `contain`, never `cover` — a security feed's cropped
 *      half is the half that matters, and `contain` is what keeps the picture
 *      whole when tile and frame disagree (a height-clamped tile in a wide,
 *      short widget; a feed that changes resolution mid-life).
 *
 * jsdom has no layout engine, so the CSS half is pinned by resolving the real
 * Home cascade against the really-rendered elements — see `helpers/css-cascade`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { collectHomeCascade, resolve } from "../helpers/css-cascade";
import type { CameraInfo } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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
 * Stand-in for the offscreen preloader, reporting a decoded frame's natural
 * size the way a real HTMLImageElement does. `natural` is per-test: a probe
 * that reports nothing (the default) is also a real case — that is the path
 * every pre-existing test in `cameras-widget.live-frame` takes.
 */
let natural: { w?: number; h?: number } = {};
let probes: { src: string; onload?: () => void; onerror?: () => void }[] = [];
class FakeImage {
  onload?: () => void;
  onerror?: () => void;
  naturalWidth?: number;
  naturalHeight?: number;
  #src = "";
  constructor() {
    this.naturalWidth = natural.w;
    this.naturalHeight = natural.h;
  }
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

/**
 * The real ancestor chain the widget mounts in. `.dh-m-board` is the phone
 * board (app/page.tsx › MobileBoard) — it is part of the fixture because it
 * carries its own `.w-cams` override, and that override is exactly where a
 * fixed tile height would come back.
 */
function renderInMobileBoard() {
  return render(
    <div className="droplet-home dh-mobile">
      <div className="dh-m-board">
        <div className="bento">
          <div className="bento-body">
            <CamerasWidget w={4} h={3} />
          </div>
        </div>
      </div>
    </div>,
  ).container;
}

describe("Home CamerasWidget · frame fit", () => {
  const homeCascade = collectHomeCascade();

  beforeEach(() => {
    cleanup();
    probes = [];
    natural = {};
    cameras = [cam({})];
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives the tile the decoded frame's own aspect ratio", async () => {
    natural = { w: 1920, h: 1080 };
    const container = renderInMobileBoard();
    await settleFirstFrame();

    const tile = container.querySelector(".w-cam") as HTMLElement;
    await waitFor(() => expect(tile.style.aspectRatio).not.toBe(""));
    expect(Number(tile.style.aspectRatio)).toBeCloseTo(16 / 9, 5);
  });

  // The ratio has to come from the frame, not from a constant that happens to
  // match the box's only camera. A 4:3 feed squeezed into 16/9 is the same
  // distortion, one aspect ratio over.
  it("follows a camera that is not 16:9", async () => {
    natural = { w: 1280, h: 960 };
    const container = renderInMobileBoard();
    await settleFirstFrame();

    const tile = container.querySelector(".w-cam") as HTMLElement;
    await waitFor(() => expect(tile.style.aspectRatio).not.toBe(""));
    expect(Number(tile.style.aspectRatio)).toBeCloseTo(4 / 3, 5);
  });

  it("leaves the shape to CSS until a frame has actually been measured", async () => {
    // A loader that cannot report a natural size must not produce
    // `aspect-ratio: NaN` / `0` — the tile stays on the stylesheet's 16/9.
    natural = { w: 0, h: 0 };
    const container = renderInMobileBoard();
    await settleFirstFrame();
    await waitFor(() =>
      expect(container.querySelector(".w-cam img")).not.toBeNull(),
    );

    const tile = container.querySelector(".w-cam") as HTMLElement;
    expect(tile.style.aspectRatio).toBe("");
  });

  it("does not split the row into columns it has no cameras to fill", () => {
    const container = renderInMobileBoard();

    // One camera in a two-column grid is the half-width, full-height slot the
    // frame was being crushed into.
    const grid = container.querySelector(".w-cams") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(1, 1fr)");
  });

  it("still uses both columns once there are tiles for them", () => {
    cameras = [cam({ name: "cam_a" }), cam({ name: "cam_b" })];
    const container = renderInMobileBoard();

    const grid = container.querySelector(".w-cams") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
  });

  it("paints the frame whole instead of cropping it to the tile", async () => {
    natural = { w: 1920, h: 1080 };
    const container = renderInMobileBoard();
    await settleFirstFrame();
    await waitFor(() =>
      expect(container.querySelector(".w-cam img")).not.toBeNull(),
    );

    const img = container.querySelector(".w-cam img") as HTMLImageElement;
    // Nothing outside the authored sheets can move this: the frame carries no
    // utility class and no inline style, so the Home cascade IS the cascade.
    expect(img.className).toBe("");
    expect(img.getAttribute("style")).toBeNull();

    const fit = resolve(img, homeCascade, "object-fit");
    expect(
      fit.contested.map((d) => `${d.sheet} \`${d.selector}\` (${d.value})`),
      "another Home stylesheet sets `object-fit` on the frame at the same " +
        "specificity; which one paints is then CSS chunk order",
    ).toEqual([]);
    expect(
      fit.winner?.value,
      "`cover` crops a 16:9 frame down to a strip when the tile is tall — " +
        "the reported defect",
    ).toBe("contain");
  });

  it("keeps a placeholder shape for the tile before any frame lands", () => {
    const container = renderInMobileBoard();
    const tile = container.querySelector(".w-cam") as HTMLElement;

    const ratio = resolve(tile, homeCascade, "aspect-ratio");
    expect(ratio.contested).toEqual([]);
    expect(
      ratio.winner?.value.replace(/\s+/g, ""),
      "without a CSS aspect-ratio the tint placeholder goes back to filling " +
        "whatever box the grid row gives it",
    ).toBe("16/9");
  });

  // The load-bearing half of the fix: stretch alignment overrides
  // `aspect-ratio` outright, because a stretched item's height is definite.
  it("centres tiles in the row rather than stretching them to it", () => {
    const container = renderInMobileBoard();
    const grid = container.querySelector(".w-cams")!;

    const align = resolve(grid, homeCascade, "align-items");
    expect(align.contested).toEqual([]);
    expect(
      align.winner?.value,
      "`.w-cams` must not stretch its tiles — a stretched tile's height is " +
        "definite, which makes its aspect-ratio inert",
    ).toBe("center");
  });

  it("stops pinning a fixed tile height on the phone board", () => {
    const container = renderInMobileBoard();
    const grid = container.querySelector(".w-cams")!;

    const height = resolve(grid, homeCascade, "height");
    expect(height.contested).toEqual([]);
    expect(
      height.winner?.value,
      "a hardcoded px height on the mobile cams grid re-imposes a shape the " +
        "frame has to fit into",
    ).toBe("auto");
  });
});
