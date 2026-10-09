/**
 * Birdseye multi-camera live view — probe contract (WARP-1918).
 *
 * QA hit the "Birdseye view isn't set up on this Droplet" empty state on
 * every box because the platform-managed Frigate config never enabled
 * birdseye (fixed in docker/frigate/config.yml + camera-discovery's
 * ensure_birdseye convergence). These tests pin the dashboard half of the
 * contract so the fix stays honest end-to-end:
 *
 *  - the page probes the proxied route (GET /api/cameras/birdseye/live, status
 *    read and the request aborted — never HEAD, see the block below; the
 *    orchestrator answers 404 only when Frigate reports birdseye disabled);
 *  - the composite grid `<img>` renders when the probe says enabled;
 *  - the empty state renders ONLY when the probe says disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

import BirdseyePage from "@/app/cameras/birdseye/page";

// The shell chrome (SWR health chip, inbox bell) is not under test here.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, actions, children }: { title?: string; sub?: string; actions?: React.ReactNode; children?: React.ReactNode }) => (
    <div>
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));

const BIRDSEYE_LIVE_URL = "/api/cameras/birdseye/live";

/** Flush the probe's .then(setAvailable) through React's commit. */
async function flushProbe() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const ENABLED = { ok: true, status: 200, headers: new Headers() };
const DISABLED = { ok: false, status: 404, headers: new Headers() };

describe("Birdseye live view (WARP-1918)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("probes the proxied birdseye route with a GET, and aborts it once the status is read", async () => {
    fetchMock.mockResolvedValue(ENABLED);
    render(<BirdseyePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushProbe();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BIRDSEYE_LIVE_URL);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal!.aborted).toBe(true);
  });

  it("renders the composite stream, not the empty state, when the probe says enabled", async () => {
    fetchMock.mockResolvedValue(ENABLED);
    render(<BirdseyePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushProbe();

    const img = screen.getByAltText("Birdseye live composite");
    expect(img).toHaveAttribute("src", BIRDSEYE_LIVE_URL);
    expect(screen.queryByText("Birdseye not enabled")).not.toBeInTheDocument();
  });

  it("renders inside the shell: page title, one-line explanation, 16:9 feed card, fullscreen button", async () => {
    fetchMock.mockResolvedValue(ENABLED);
    render(<BirdseyePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushProbe();

    expect(screen.getByRole("heading", { name: "Birdseye" })).toBeInTheDocument();
    expect(
      screen.getByText("Every active camera in one view; cameras with motion come forward."),
    ).toBeInTheDocument();
    const feed = screen.getByAltText("Birdseye live composite").parentElement!;
    expect(feed).toHaveAttribute("id", "birdseye-feed");
    expect(feed.className).toContain("aspect-video");
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Cameras/ })).toBeInTheDocument();
  });

  it("renders the not-enabled empty state only when the probe says disabled", async () => {
    fetchMock.mockResolvedValue(DISABLED);
    render(<BirdseyePage />);

    await screen.findByText("Birdseye not enabled");
    expect(
      screen.getByText(/isn't set up on this Droplet yet/),
    ).toBeInTheDocument();
    // The empty state names the cause (restream) and says it will appear on its own.
    expect(screen.getByText(/restream option/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeDisabled();
    expect(
      screen.queryByAltText("Birdseye live composite"),
    ).not.toBeInTheDocument();
  });

  it("treats a probe transport failure as disabled rather than a black feed", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    render(<BirdseyePage />);

    await screen.findByText("Birdseye not enabled");
    expect(
      screen.queryByAltText("Birdseye live composite"),
    ).not.toBeInTheDocument();
  });

  it("does not flash the empty state while the probe is still in flight", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<BirdseyePage />);

    expect(screen.queryByText("Birdseye not enabled")).not.toBeInTheDocument();
    expect(screen.getByAltText("Birdseye live composite")).toBeInTheDocument();
  });
});

/**
 * Birdseye is an endless MJPEG stream, and two things about it went wrong on
 * this page:
 *
 *  - Express runs the GET handler for a HEAD, and Node sends a HEAD's headers
 *    only when the response ends, which a live stream never does. The page's
 *    HEAD check therefore never answered, and (having no signal) stayed open,
 *    holding a proxied Frigate stream for as long as the tab lived, and after
 *    it was left. The check is now a GET whose status is read off the headers
 *    and aborted at once (`getBirdseyeStatus`).
 *  - A clean end of the upstream stream freezes the last frame with no
 *    `error` event. Only reconnecting bounds a frozen picture, so a live
 *    stream reconnects every 5 minutes.
 *
 * The route is modelled as the orchestrator behaves: a GET answers its headers
 * at once and the body stays open until the request is aborted; a HEAD is
 * never answered.
 */
describe("Birdseye live view — a live stream never freezes the page", () => {
  const fetchMock = vi.fn();
  /** Requests still open: not aborted, and (a HEAD) never answered. */
  let open: Set<number>;

  /** `getAnswers`: the GET answers its status at once (a live stream) or hangs until aborted. */
  function liveRoute(getAnswers: boolean) {
    let n = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const id = n++;
      open.add(id);
      init?.signal?.addEventListener("abort", () => open.delete(id));
      const method = init?.method ?? "GET";
      if (method === "HEAD" || !getAnswers) {
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers() });
    });
  }

  const RECONNECT_MS = 5 * 60_000;

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    open = new Set();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves no request open once its check has an answer", async () => {
    liveRoute(true);
    render(<BirdseyePage />);
    await advance(0);

    expect(fetchMock).toHaveBeenCalled();
    expect([...open]).toEqual([]);
    expect(screen.getByAltText("Birdseye live composite")).toBeInTheDocument();
  });

  it("never asks with a HEAD, which a live stream never answers", async () => {
    liveRoute(true);
    render(<BirdseyePage />);
    await advance(0);

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });

  it("leaving the page abandons a check that has not answered", async () => {
    liveRoute(false);
    const { unmount } = render(<BirdseyePage />);
    await advance(0);
    expect(open.size).toBe(1);

    unmount();
    expect([...open]).toEqual([]);
  });

  it("reconnects the live stream every 5 minutes: a clean upstream end freezes the last frame with no error", async () => {
    liveRoute(true);
    render(<BirdseyePage />);
    await advance(0);
    const first = screen.getByAltText("Birdseye live composite").getAttribute("src");

    await advance(RECONNECT_MS - 1);
    expect(screen.getByAltText("Birdseye live composite").getAttribute("src")).toBe(first);

    await advance(1);
    const second = screen.getByAltText("Birdseye live composite").getAttribute("src");
    expect(second).not.toBe(first);
    expect(second).toContain("/api/cameras/birdseye/live");

    await advance(RECONNECT_MS);
    const third = screen.getByAltText("Birdseye live composite").getAttribute("src");
    expect(third).not.toBe(second);
    expect(third).not.toBe(first);
  });

  it("does not reconnect a stream that is not on screen, and leaves no timer behind", async () => {
    // Not enabled: nothing is streaming, so there is nothing to reconnect.
    fetchMock.mockResolvedValue(DISABLED);
    const { unmount } = render(<BirdseyePage />);
    await advance(0);
    expect(screen.getByText("Birdseye not enabled")).toBeInTheDocument();
    await advance(RECONNECT_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();

    // A stream that errored is on screen as "Stream lost": nothing to reconnect either.
    liveRoute(true);
    fetchMock.mockClear();
    const lost = render(<BirdseyePage />);
    await advance(0);
    fireEvent.error(screen.getByAltText("Birdseye live composite"));
    expect(screen.getByText(/Stream lost/)).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    lost.unmount();

    // Live: leaving the page stops the reconnect.
    liveRoute(true);
    fetchMock.mockClear();
    const live = render(<BirdseyePage />);
    await advance(0);
    live.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
