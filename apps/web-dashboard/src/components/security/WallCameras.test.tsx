/**
 * WARP-2981 (ADR-059 P6, D6 — Stefan: "Member wall, own cameras") — the
 * wall's camera tiles (T-D8).
 *
 * `authFetch` is mocked one layer under `getWallCameraSnapshot`, so what is
 * pinned is what the TV really asks for: one camera's latest picture, for the
 * cameras the list gave and no other (DS-005), never for a camera that is
 * turned off or not sending pictures (its last frame would be a frozen one).
 * Then each tile's own clock: live, stale after 15 s under its own time
 * (dimmed, never drawn as current), "No picture yet" while it keeps trying,
 * a fresh picture every 3 s, and nothing left asking after unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: null }) }));

import { WallCameras, type WallCamerasProps } from "./WallCameras";
import { COPY as FEED_COPY } from "./SecurityFeed";
import { WALL_COPY } from "./wall-status";
import type { CameraInfo } from "@/lib/types";

const cam = (name: string, over: Partial<CameraInfo> = {}): CameraInfo => ({
  name,
  displayName: "",
  manufacturer: null,
  model: null,
  ipAddress: "10.0.0.2",
  macAddress: null,
  enabled: true,
  autoDiscovered: false,
  status: "recording",
  lastSeen: "2026-09-25T20:00:00.000Z",
  lastDetection: null,
  ...over,
});

/** Paths answering 503; everything else a JPEG. */
let failing: Set<string>;
let objectUrls: number;

const picturePaths = () =>
  (h.authFetch.mock.calls as Array<[string, RequestInit]>).map(([url]) => url.split("?")[0]!);
const asked = (name: string) => picturePaths().filter((p) => p === `/api/cameras/${name}/snapshot`).length;
const tile = (name: string) => document.querySelector(`[data-camera="${name}"]`) as HTMLElement;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const time = (ms: number) => `T${new Date(ms).toISOString().slice(11, 19)}`;
function props(over: Partial<WallCamerasProps>): WallCamerasProps {
  return { allowed: true, noCameraSystem: false, cameras: null, listFailed: false, now: Date.now(), time, ...over };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-25T21:00:00.000Z") });
  failing = new Set();
  objectUrls = 0;
  URL.createObjectURL = vi.fn(() => `blob:picture-${++objectUrls}`);
  URL.revokeObjectURL = vi.fn();
  h.authFetch.mockReset().mockImplementation(async (url: string) => {
    const path = url.split("?")[0]!;
    const status = failing.has(path) ? 503 : 200;
    return { ok: status === 200, status, blob: async () => new Blob(["jpeg"], { type: "image/jpeg" }), headers: new Headers() };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WallCameras — one note instead of tiles", () => {
  it("before the modules read answers: connecting, and no request", async () => {
    const { container } = render(<WallCameras {...props({ allowed: null })} />, { wrapper: Wrap });
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(WALL_COPY.camerasConnecting)).toBeInTheDocument();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("Cameras not open to this account: 'can't see any cameras yet', and no request", async () => {
    render(<WallCameras {...props({ allowed: false })} />, { wrapper: Wrap });
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(WALL_COPY.camerasNone)).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.camerasNoneBody)).toBeInTheDocument();
  });

  it("an account with no cameras granted: the same empty state", async () => {
    render(<WallCameras {...props({ cameras: [] })} />, { wrapper: Wrap });
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(WALL_COPY.camerasNone)).toBeInTheDocument();
    expect(document.querySelector("figure")).toBeNull();
  });

  it("no camera system: says so, and no request", async () => {
    render(<WallCameras {...props({ noCameraSystem: true, cameras: [cam("front")] })} />, { wrapper: Wrap });
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(FEED_COPY.emptyNoCameras)).toBeInTheDocument();
  });

  it("the list failing before it ever answered: 'isn't coming through', never 'can't see any cameras'", async () => {
    render(<WallCameras {...props({ listFailed: true })} />, { wrapper: Wrap });
    expect(screen.getByText(WALL_COPY.camerasLost)).toBeInTheDocument();
    expect(screen.queryByText(WALL_COPY.camerasNone)).toBeNull();
  });

  it("the list not answered yet: connecting", async () => {
    render(<WallCameras {...props({})} />, { wrapper: Wrap });
    expect(screen.getByText(WALL_COPY.camerasConnecting)).toBeInTheDocument();
  });
});

describe("WallCameras — exactly this account's cameras (DS-005)", () => {
  it("a tile for each camera on the list, in its order, named as the household named it — and pictures asked for those alone", async () => {
    const cameras = [cam("back_door", { displayName: "Back door" }), cam("stock_room", { displayName: "Stock room" }), cam("yard_2")];
    render(<WallCameras {...props({ cameras })} />, { wrapper: Wrap });
    await advance(0);
    const tiles = [...document.querySelectorAll("figure[data-camera]")];
    expect(tiles.map((t) => t.getAttribute("data-camera"))).toEqual(["back_door", "stock_room", "yard_2"]);
    expect(tiles.map((t) => t.querySelector(".sec-wall-tile-name")!.textContent)).toEqual(["Back door", "Stock room", "yard_2"]);
    expect(new Set(picturePaths())).toEqual(new Set(["/api/cameras/back_door/snapshot", "/api/cameras/stock_room/snapshot", "/api/cameras/yard_2/snapshot"]));
    expect(screen.getByAltText("Back door, latest picture")).toHaveAttribute("src", expect.stringMatching(/^blob:picture-\d+$/));
  });

  it("each picture is a GET at 720 px that bypasses the HTTP cache, with a timeout", async () => {
    render(<WallCameras {...props({ cameras: [cam("front")] })} />, { wrapper: Wrap });
    await advance(0);
    const [url, init] = h.authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cameras/front/snapshot?h=720");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["turned off", { enabled: false }, WALL_COPY.tileOff, "off"],
    ["offline", { status: "offline" as const }, WALL_COPY.tileNotSending, "not_sending"],
    ["idle (no frames)", { status: "idle" as const }, WALL_COPY.tileNotSending, "not_sending"],
  ])("a camera %s: never asked, no picture — it says so", async (_why, over, line, state) => {
    render(<WallCameras {...props({ cameras: [cam("front", { displayName: "Front", ...over }), cam("back", { displayName: "Back" })] })} />, {
      wrapper: Wrap,
    });
    await advance(60_000);
    expect(asked("front")).toBe(0);
    expect(asked("back")).toBeGreaterThan(0);
    expect(tile("front").querySelector("img")).toBeNull();
    expect(tile("front")).toHaveTextContent(line);
    expect(tile("front")).toHaveAttribute("data-state", state);
  });

  it("a camera that stops sending pictures drops its picture at once — no frozen frame", async () => {
    const { rerender } = render(<WallCameras {...props({ cameras: [cam("front", { displayName: "Front" })] })} />, { wrapper: Wrap });
    await advance(0);
    expect(screen.getByAltText("Front, latest picture")).toBeInTheDocument();
    const before = asked("front");
    rerender(<WallCameras {...props({ cameras: [cam("front", { displayName: "Front", status: "offline" })] })} />);
    await advance(30_000);
    expect(screen.queryByAltText("Front, latest picture")).toBeNull();
    expect(asked("front")).toBe(before);
  });

  it("lays the tiles out as the nearest square: 3 cameras → 2 × 2", async () => {
    render(<WallCameras {...props({ cameras: [cam("a"), cam("b"), cam("c")] })} />, { wrapper: Wrap });
    const grid = document.querySelector(".sec-wall-tiles") as HTMLElement;
    expect(grid.style.getPropertyValue("--cols")).toBe("2");
    expect(grid.style.getPropertyValue("--rows")).toBe("2");
  });
});

describe("WallCameras — a tile's own clock", () => {
  it("a new picture every 3 s; the one it replaces is let go", async () => {
    render(<WallCameras {...props({ cameras: [cam("front")] })} />, { wrapper: Wrap });
    await advance(0);
    expect(asked("front")).toBe(1);
    await advance(3_000);
    expect(asked("front")).toBe(2);
    await advance(3_000);
    expect(asked("front")).toBe(3);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:picture-1");
  });

  it("pictures failing: live up to 15 s, then the last one stays — dimmed, grey, under its own time", async () => {
    const t0 = Date.now();
    const cameras = [cam("front", { displayName: "Front" })];
    const { rerender } = render(<WallCameras {...props({ cameras, now: t0 })} />, { wrapper: Wrap });
    await advance(0);
    expect(tile("front")).toHaveAttribute("data-state", "live");
    expect(tile("front").querySelector(".sec-wall-tile-state")).toBeNull();
    failing.add("/api/cameras/front/snapshot");
    await advance(15_000);
    rerender(<WallCameras {...props({ cameras, now: t0 + 15_000 })} />);
    expect(tile("front")).toHaveAttribute("data-state", "live");
    rerender(<WallCameras {...props({ cameras, now: t0 + 15_001 })} />);
    expect(tile("front")).toHaveAttribute("data-state", "stale");
    expect(tile("front")).toHaveClass("is-stale");
    expect(screen.getByAltText("Front, latest picture")).toBeInTheDocument();
    expect(tile("front")).toHaveTextContent(`Picture from ${time(t0)}`);
    // The mark scales with the badge's text (a TV's clamp), never a fixed 12 px.
    expect(tile("front").querySelector(".badge.warn svg")).toHaveAttribute("width", "1em");
    expect(tile("front").querySelector(".badge.warn svg")).toHaveAttribute("height", "1em");
    // Answers again: live, no age.
    failing.clear();
    await advance(120_000);
    rerender(<WallCameras {...props({ cameras, now: Date.now() })} />);
    expect(tile("front")).toHaveAttribute("data-state", "live");
    expect(tile("front")).not.toHaveClass("is-stale");
  });

  it("no picture yet and the first ask failed: 'No picture yet', then its retry — 3 s, 6 s, 12 s — brings it", async () => {
    failing.add("/api/cameras/front/snapshot");
    render(<WallCameras {...props({ cameras: [cam("front", { displayName: "Front" })] })} />, { wrapper: Wrap });
    await advance(0);
    expect(tile("front")).toHaveAttribute("data-state", "lost");
    expect(tile("front")).toHaveTextContent(WALL_COPY.tileLost);
    expect(tile("front").querySelector("img")).toBeNull();
    await advance(3_000);
    expect(asked("front")).toBe(2);
    await advance(6_000);
    expect(asked("front")).toBe(3);
    failing.clear();
    await advance(12_000);
    expect(asked("front")).toBe(4);
    expect(tile("front")).toHaveAttribute("data-state", "live");
  });

  it("the retries never back off past 2 minutes", async () => {
    failing.add("/api/cameras/front/snapshot");
    render(<WallCameras {...props({ cameras: [cam("front")] })} />, { wrapper: Wrap });
    await advance(30 * 60_000);
    const n = asked("front");
    await advance(120_000);
    expect(asked("front")).toBe(n + 1);
  });

  it("before the first picture: connecting, not a blank tile", async () => {
    h.authFetch.mockImplementation(() => new Promise(() => {}));
    render(<WallCameras {...props({ cameras: [cam("front")] })} />, { wrapper: Wrap });
    await advance(1_000);
    expect(tile("front")).toHaveAttribute("data-state", "connecting");
    expect(tile("front")).toHaveTextContent(WALL_COPY.tileConnecting);
  });

  it("every state line sits on the picture, and the caption is the camera's name alone — no state can crowd a name out", async () => {
    // Internal review, round 4: in the caption beside the name, "⚠ Picture from 9:41 PM" left a 226 px tile's name 6–9 px.
    const base = h.authFetch.getMockImplementation()!;
    h.authFetch.mockImplementation((url: string, init: RequestInit) => (url.startsWith("/api/cameras/wait/") ? new Promise(() => {}) : base(url, init)));
    failing.add("/api/cameras/lost/snapshot");
    const cameras = [
      cam("off", { displayName: "Front door", enabled: false }),
      cam("quiet", { displayName: "Driveway", status: "offline" }),
      cam("lost", { displayName: "Back garden" }),
      cam("wait", { displayName: "Porch" }),
      cam("old", { displayName: "Basement stairs" }),
    ];
    const { rerender } = render(<WallCameras {...props({ cameras })} />, { wrapper: Wrap });
    await advance(0);
    failing.add("/api/cameras/old/snapshot");
    await advance(20_000);
    rerender(<WallCameras {...props({ cameras, now: Date.now() })} />);
    expect(cameras.map((c) => tile(c.name).getAttribute("data-state"))).toEqual(["off", "not_sending", "lost", "connecting", "stale"]);
    for (const c of cameras) {
      expect(tile(c.name).querySelector("figcaption")!.textContent).toBe(c.displayName);
      expect(tile(c.name).querySelector(".sec-wall-tile-frame > .sec-wall-tile-state")).not.toBeNull();
    }
    expect(tile("old").querySelector(".sec-wall-tile-frame > .sec-wall-tile-state")).toHaveTextContent(/^Picture from T\d/);
  });

  it("unmounting stops every tile asking", async () => {
    const { unmount } = render(<WallCameras {...props({ cameras: [cam("front"), cam("back")] })} />, { wrapper: Wrap });
    await advance(0);
    unmount();
    const n = h.authFetch.mock.calls.length;
    await advance(10 * 60_000);
    expect(h.authFetch.mock.calls.length).toBe(n);
  });
});
