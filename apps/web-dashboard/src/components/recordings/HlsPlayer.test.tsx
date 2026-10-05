/**
 * WARP-3509 — HlsPlayer must tell its parent when the video cannot play, on
 * every path it plays by.
 *
 * Chromium plays HLS natively now, and answers `canPlayType(
 * "application/vnd.apple.mpegurl")` with "maybe". HlsPlayer's native branch
 * (written for Safari) set `video.src` and listened to nothing, so a playlist
 * that failed to load left the <video> in error code 4 with its controls up,
 * and the parent — the event clip modal, the Recordings page — never heard: a
 * dead player, no notice, no fallback. The native branch now reports the media
 * error through `onError`, the way the hls.js branch reports a fatal one.
 *
 * jsdom has neither a media pipeline nor MediaSource, so what is under test is
 * the wiring: which branch runs, what it listens to, what it tells the parent.
 * hls.js is replaced by a stand-in that records how it was driven.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const hls = vi.hoisted(() => ({
  supported: true,
  instances: [] as Array<{
    loadSource: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    emit: (details: string, fatal: boolean) => void;
  }>,
}));

vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() {
      return hls.supported;
    }
    static Events = { ERROR: "hlsError" };
    private onError: ((event: string, data: { fatal: boolean; details: string; type: string }) => void) | null = null;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    constructor() {
      hls.instances.push({
        loadSource: this.loadSource,
        attachMedia: this.attachMedia,
        destroy: this.destroy,
        emit: (details, fatal) => this.onError?.("hlsError", { fatal, details, type: "networkError" }),
      });
    }
    on(_event: string, handler: NonNullable<FakeHls["onError"]>) {
      this.onError = handler;
    }
  }
  return { default: FakeHls };
});

import { HlsPlayer } from "./HlsPlayer";
import { translateError } from "@/lib/friendly-errors";

const PLAYLIST = "/api/cameras/events/1791059989.433851-abc123/playback.m3u8";

/** A browser that answers the way Chromium does: HLS is "maybe" playable. */
function chromiumCanPlayHls() {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type) =>
    type === "application/vnd.apple.mpegurl" ? "maybe" : "",
  );
}

/** What the media element reports when its load fails: `video.error` set, then an `error` event. */
function mediaError(video: HTMLVideoElement, code: number | null) {
  Object.defineProperty(video, "error", {
    configurable: true,
    value: code === null ? null : { code, message: "" },
  });
  fireEvent.error(video);
}

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

beforeEach(() => {
  hls.supported = true;
  hls.instances.length = 0;
  // jsdom reports `Not implemented` for load(); the player calls it on teardown.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  // translateError logs the raw cause for operators.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HlsPlayer native playback (Chromium, Safari)", () => {
  it("plays the playlist straight through the video element, without loading hls.js", () => {
    chromiumCanPlayHls();
    const { container } = render(<HlsPlayer src={PLAYLIST} />);

    expect(container.querySelector("video")!.getAttribute("src")).toBe(PLAYLIST);
    expect(hls.instances).toHaveLength(0);
  });

  it("tells the parent when the playlist cannot be loaded (MediaError 4), instead of leaving a dead player", () => {
    chromiumCanPlayHls();
    const onError = vi.fn();
    const { container } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);

    mediaError(container.querySelector("video")!, MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(translateError({ code: "manifestLoadError" }, "media"));
  });

  it.each([
    ["a network failure while streaming", MEDIA_ERR_NETWORK, "networkError"],
    ["a decode failure", MEDIA_ERR_DECODE, "mediaError"],
    ["a source the browser cannot play", MEDIA_ERR_SRC_NOT_SUPPORTED, "manifestLoadError"],
    ["an error the element gives no reason for", null, "mediaError"],
  ])("reports %s in the plain-language copy, never the raw code", (_why, code, enumValue) => {
    chromiumCanPlayHls();
    const onError = vi.fn();
    const { container } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);

    mediaError(container.querySelector("video")!, code);

    const message = onError.mock.calls[0][0] as string;
    expect(message).toBe(translateError({ code: enumValue }, "media"));
    expect(message).not.toMatch(/MediaError|MEDIA_ERR|networkError|manifestLoadError|mediaError/);
  });

  it("does not report the page cancelling its own load as a failure (MediaError 1)", () => {
    chromiumCanPlayHls();
    const onError = vi.fn();
    const { container } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);

    mediaError(container.querySelector("video")!, MEDIA_ERR_ABORTED);

    expect(onError).not.toHaveBeenCalled();
  });

  it("works with no onError: a failed load is not an exception", () => {
    chromiumCanPlayHls();
    const { container } = render(<HlsPlayer src={PLAYLIST} />);

    expect(() => mediaError(container.querySelector("video")!, MEDIA_ERR_SRC_NOT_SUPPORTED)).not.toThrow();
  });

  it("stops listening once it is unmounted", () => {
    chromiumCanPlayHls();
    const onError = vi.fn();
    const { container, unmount } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);
    const video = container.querySelector("video")!;

    unmount();
    mediaError(video, MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(onError).not.toHaveBeenCalled();
  });

  it("moving to another playlist neither leaks the old listener nor reports twice", () => {
    chromiumCanPlayHls();
    const onError = vi.fn();
    const { container, rerender } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);

    rerender(<HlsPlayer src={`${PLAYLIST}?refresh=1`} onError={onError} />);
    mediaError(container.querySelector("video")!, MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${PLAYLIST}?refresh=1`);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("HlsPlayer through hls.js (browsers with no native HLS)", () => {
  it("drives hls.js, not the video's own src", async () => {
    const { container } = render(<HlsPlayer src={PLAYLIST} />);

    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));
    expect(hls.instances[0].loadSource).toHaveBeenCalledWith(PLAYLIST);
    expect(hls.instances[0].attachMedia).toHaveBeenCalledWith(container.querySelector("video"));
    expect(container.querySelector("video")!.getAttribute("src")).toBeNull();
  });

  it("reports a fatal hls.js error in plain language", async () => {
    const onError = vi.fn();
    render(<HlsPlayer src={PLAYLIST} onError={onError} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));

    hls.instances[0].emit("manifestLoadError", true);

    expect(onError).toHaveBeenCalledWith(translateError({ code: "manifestLoadError" }, "media"));
  });

  it("says nothing about a recoverable hls.js error", async () => {
    const onError = vi.fn();
    render(<HlsPlayer src={PLAYLIST} onError={onError} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));

    hls.instances[0].emit("bufferStalledError", false);

    expect(onError).not.toHaveBeenCalled();
  });

  it("tears hls.js down when the player unmounts", async () => {
    const { unmount } = render(<HlsPlayer src={PLAYLIST} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));

    unmount();

    expect(hls.instances[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("ignores a fatal callback from a playlist that was replaced", async () => {
    const onError = vi.fn();
    const { rerender } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));

    rerender(<HlsPlayer src={`${PLAYLIST}?refresh=1`} onError={onError} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(2));
    hls.instances[0].emit("manifestLoadError", true);

    expect(onError).not.toHaveBeenCalled();
    hls.instances[1].emit("manifestLoadError", true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores a fatal callback after the player was unmounted", async () => {
    const onError = vi.fn();
    const { unmount } = render(<HlsPlayer src={PLAYLIST} onError={onError} />);
    await vi.waitFor(() => expect(hls.instances).toHaveLength(1));

    unmount();
    hls.instances[0].emit("manifestLoadError", true);

    expect(onError).not.toHaveBeenCalled();
  });

  it("a browser with neither native HLS nor MSE gets the unsupported-browser copy", async () => {
    hls.supported = false;
    const onError = vi.fn();
    render(<HlsPlayer src={PLAYLIST} onError={onError} />);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(translateError({ code: "UNSUPPORTED" }, "media")));
    expect(hls.instances).toHaveLength(0);
  });
});
