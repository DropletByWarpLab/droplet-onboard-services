/**
 * WARP-3509 — the HLS window an event clip plays over.
 *
 * Frigate 0.17's `GET /api/events/<id>/clip.mp4` is a fragmented mp4 ffmpeg
 * streams on the fly: no duration in its header, its index at the END, no
 * `Content-Length`, `Range` ignored. A browser's `<video src>` cannot read a
 * duration from it, cannot seek it, and stalls on a long one. An event plays as
 * HLS instead — over Frigate's nginx-vod endpoint, the way the Recordings page
 * plays an hour — and this is the window it is asked for.
 *
 * The window is the footage Frigate keeps for an event: its start and end plus
 * the pre/post-capture padding, so a clip opens before the thing that
 * triggered it and runs a moment past it.
 */

/**
 * Longest window an event plays: an hour, the Recordings page's own window.
 * An event lasts as long as the thing is tracked — a parked car is one for as
 * long as it is parked — and nginx-vod's mapping for a window that long outgrows
 * what it will take (`vod_max_mapping_response_size 1m`: one clip per 10 s
 * recording segment), which would leave nothing to play at all. The first hour
 * plays; the Recordings page reaches the rest.
 */
export const MAX_EVENT_PLAYBACK_SEC = 60 * 60;

export interface EventPlaybackWindow {
  /** Unix seconds, whole. */
  after: number;
  /** Unix seconds, whole. */
  before: number;
}

/**
 * `start − preSec … end + postSec`, rounded outward to whole seconds.
 *
 * An event still in progress (`endTime` null) runs to `nowSec` with no padding
 * past it, and an event that has only just ended stops at `nowSec` too:
 * footage cannot exist ahead of the clock, and asking for it gets a VOD manifest
 * Frigate 404s (WARP-1958). Never longer than `MAX_EVENT_PLAYBACK_SEC`, and
 * never empty.
 */
export function eventPlaybackWindow(
  event: { startTime: number; endTime: number | null },
  padding: { preSec: number; postSec: number },
  nowSec: number,
): EventPlaybackWindow {
  const after = Math.floor(event.startTime - padding.preSec);
  const end = event.endTime === null ? nowSec : Math.ceil(event.endTime + padding.postSec);
  const before = Math.min(end, nowSec, after + MAX_EVENT_PLAYBACK_SEC);
  return { after, before: Math.max(before, after + 1) };
}
