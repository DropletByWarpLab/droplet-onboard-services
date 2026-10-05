import { describe, expect, it } from "vitest";
import { archiveToMediaTime, mediaToArchiveTime } from "./archive-time";
import type { RecordingSegment } from "@/lib/types";

const segment = (startTime: number, endTime: number): RecordingSegment => ({ id: String(startTime), startTime, endTime, duration: endTime - startTime, motion: 0, objects: 0 });
const segments = [segment(100, 110), segment(160, 180)];

describe("recording playback across gaps", () => {
  it("seeks a real archive timestamp after a gap without adding the missing time", () => {
    expect(archiveToMediaTime(segments, 90, 200, 165)).toBe(15);
    expect(mediaToArchiveTime(segments, 90, 200, 15)).toBe(165);
  });
  it("snaps a time with no recording to the next retained segment", () => {
    expect(archiveToMediaTime(segments, 90, 200, 130)).toBe(10);
    expect(mediaToArchiveTime(segments, 90, 200, 10)).toBe(160);
  });
  it("trims segments overlapping the window edges", () => {
    expect(archiveToMediaTime(segments, 105, 170, 165)).toBe(10);
    expect(mediaToArchiveTime(segments, 105, 170, 0)).toBe(105);
    expect(mediaToArchiveTime(segments, 105, 170, 15)).toBe(170);
  });
  it("handles out-of-order records and an empty hour", () => {
    expect(archiveToMediaTime([...segments].reverse(), 90, 200, 165)).toBe(15);
    expect(mediaToArchiveTime([], 200, 300, 10)).toBe(200);
  });
});
