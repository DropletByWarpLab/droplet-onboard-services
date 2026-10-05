import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { HlsPlayer, type HlsPlayerHandle } from "./HlsPlayer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("native HLS playback", () => {
  it("does not restart the stream when the error callback changes", () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const first = vi.fn(), latest = vi.fn();
    const { rerender, container } = render(<HlsPlayer src="/recording.m3u8" onError={first} />);
    rerender(<HlsPlayer src="/recording.m3u8" onError={latest} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.error(container.querySelector("video")!);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it("waits for metadata before applying a seek and uses the chosen speed", () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const ref = createRef<HlsPlayerHandle>(), ready = vi.fn();
    const { container } = render(<HlsPlayer ref={ref} src="/recording.m3u8" onReady={ready} playbackRate={4} />);
    const video = container.querySelector("video")!;
    ref.current!.seek(15);
    expect(video.currentTime).toBe(0);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(15);
    expect(video.playbackRate).toBe(4);
    expect(ready).toHaveBeenCalledOnce();
  });
  it("clears a pending seek when switching to a different recording", () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const ref = createRef<HlsPlayerHandle>();
    const { container, rerender } = render(<HlsPlayer ref={ref} src="/first.m3u8" />);
    ref.current!.seek(15);
    rerender(<HlsPlayer ref={ref} src="/second.m3u8" />);
    fireEvent.loadedMetadata(container.querySelector("video")!);
    expect(container.querySelector("video")!.currentTime).toBe(0);
  });
});
