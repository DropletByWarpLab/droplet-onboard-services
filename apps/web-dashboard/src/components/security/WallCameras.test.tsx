/**
 * WARP-2981 (ADR-059 P6) — the wall's camera composite (T-D8).
 *
 * `authFetch` is mocked one layer under `getBirdseyeStatus`, so what is pinned
 * is the request the page really makes: a GET (never HEAD — a continuous MJPEG
 * stream never answers one) whose signal is aborted as soon as the status is
 * read, and only when the viewer may ask at all. Then the state machine:
 * live and reconnecting every 5 min, a 404's one neutral line re-asked every
 * 10 min, anything else lost and retried on the wall's backoff, and nothing
 * left running after unmount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: null }) }));

import { WallCameras } from "./WallCameras";
import { COPY as FEED_COPY } from "./SecurityFeed";
import { WALL_COPY } from "./wall-status";

const URL = "/api/cameras/birdseye/live";
const answer = (status: number) => Promise.resolve({ status, ok: status >= 200 && status < 300 });

/** Let the check's promise chain settle inside act. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

const img = () => screen.queryByAltText(WALL_COPY.camerasAlt) as HTMLImageElement | null;

beforeEach(() => {
  vi.useFakeTimers();
  h.authFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WallCameras — when it may ask", () => {
  it("before the modules read answers: connecting, and no request", async () => {
    const { container } = render(<WallCameras allowed={null} noCameraSystem={false} />);
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(WALL_COPY.camerasConnecting)).toBeInTheDocument();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("Cameras not open to this viewer: the neutral line, and no request (each would be a denial row)", async () => {
    render(<WallCameras allowed={false} noCameraSystem={false} />);
    await advance(20 * 60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(WALL_COPY.camerasUnavailable)).toBeInTheDocument();
  });

  it("no camera system: says so, and no request", async () => {
    render(<WallCameras allowed={true} noCameraSystem={true} />);
    await advance(60_000);
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(screen.getByText(FEED_COPY.emptyNoCameras)).toBeInTheDocument();
  });
});

describe("WallCameras — the check", () => {
  it("is a GET whose signal is aborted once the status is read", async () => {
    h.authFetch.mockReturnValue(answer(200));
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    expect(h.authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(true);
  });

  it("a request that never answers is given up after 20 s — lost, not stuck on connecting", async () => {
    h.authFetch.mockImplementation((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await advance(19_999);
    expect(screen.getByText(WALL_COPY.camerasConnecting)).toBeInTheDocument();
    await advance(1);
    expect(screen.getByText(WALL_COPY.camerasLost)).toBeInTheDocument();
  });
});

describe("WallCameras — live", () => {
  it("2xx → the composite, reconnected every 5 minutes", async () => {
    h.authFetch.mockReturnValue(answer(200));
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    expect(img()?.getAttribute("src")).toBe(`${URL}?w=0`);
    await advance(5 * 60_000 - 1);
    expect(img()?.getAttribute("src")).toBe(`${URL}?w=0`);
    await advance(1);
    expect(img()?.getAttribute("src")).toBe(`${URL}?w=1`);
    await advance(5 * 60_000);
    expect(img()?.getAttribute("src")).toBe(`${URL}?w=2`);
    // A reconnect is a new src, not another check.
    expect(h.authFetch).toHaveBeenCalledTimes(1);
  });

  it("the stream failing → lost, then checked again on the backoff", async () => {
    h.authFetch.mockReturnValue(answer(200));
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    fireEvent.error(img()!);
    await settle();
    expect(screen.getByText(WALL_COPY.camerasLost)).toBeInTheDocument();
    expect(screen.getByText(WALL_COPY.camerasLostBody)).toBeInTheDocument();
    await advance(15_000);
    expect(h.authFetch).toHaveBeenCalledTimes(2);
    expect(img()).not.toBeNull();
  });
});

describe("WallCameras — not available, or lost", () => {
  it("404 → the neutral line (never 'lost'), asked again only after 10 minutes", async () => {
    h.authFetch.mockReturnValue(answer(404));
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    expect(screen.getByText(WALL_COPY.camerasUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(WALL_COPY.camerasLost)).toBeNull();
    expect(img()).toBeNull();
    await advance(10 * 60_000 - 1);
    expect(h.authFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.authFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 500", () => answer(500)],
    ["a 502", () => answer(502)],
    ["no answer at all", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("%s → lost (not the 404 line), re-asked at 15 s then 30 s", async (_why, reply) => {
    h.authFetch.mockImplementation(reply);
    render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    expect(screen.getByText(WALL_COPY.camerasLost)).toBeInTheDocument();
    expect(screen.queryByText(WALL_COPY.camerasUnavailable)).toBeNull();
    await advance(15_000 - 1);
    expect(h.authFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.authFetch).toHaveBeenCalledTimes(2);
    await advance(30_000 - 1);
    expect(h.authFetch).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(h.authFetch).toHaveBeenCalledTimes(3);
  });

  it("unmounting stops everything: no more checks, no reconnects", async () => {
    h.authFetch.mockReturnValue(answer(500));
    const { unmount } = render(<WallCameras allowed={true} noCameraSystem={false} />);
    await settle();
    unmount();
    await advance(60 * 60_000);
    expect(h.authFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
