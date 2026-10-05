import type { RecordingSegment } from "@/lib/types";

/** Frigate VOD joins recorded segments together; absent archive time is skipped. */
export function playbackSpans(segments: RecordingSegment[], after: number, before: number) {
  let elapsed = 0;
  return [...segments].sort((a, b) => a.startTime - b.startTime).flatMap((s) => {
    const start = Math.max(after, s.startTime);
    const end = Math.min(before, s.endTime);
    const duration = Math.max(0, s.duration - (start - s.startTime) - (s.endTime - end));
    if (end <= start || duration <= 0) return [];
    const span = { start, end, duration, elapsed };
    elapsed += duration;
    return [span];
  });
}
export function archiveToMediaTime(segments: RecordingSegment[], after: number, before: number, timestamp: number) {
  const spans = playbackSpans(segments, after, before);
  for (const s of spans) {
    if (timestamp <= s.start) return s.elapsed;
    if (timestamp < s.end) return s.elapsed + (timestamp - s.start) / (s.end - s.start) * s.duration;
  }
  const last = spans.at(-1);
  return last ? last.elapsed + last.duration : 0;
}
export function mediaToArchiveTime(segments: RecordingSegment[], after: number, before: number, currentTime: number) {
  const spans = playbackSpans(segments, after, before);
  for (const s of spans) {
    if (currentTime < s.elapsed + s.duration) return s.start + Math.max(0, currentTime - s.elapsed) / s.duration * (s.end - s.start);
  }
  return spans.at(-1)?.end ?? after;
}
