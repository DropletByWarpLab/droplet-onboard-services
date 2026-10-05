import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordingsTimeline, zoomTimelineViewport } from "./RecordingsTimeline";
import type { RecordingSegment } from "@/lib/types";

const day = "2026-08-13";
const timestamp = (hour: number, minute = 0) => new Date(2026, 7, 13, hour, minute).getTime() / 1000;
const segment = (startTime: number, endTime: number, motion = 0): RecordingSegment => ({ id: String(startTime), startTime, endTime, duration: endTime - startTime, motion, objects: 0 });
const setup = (props: Partial<React.ComponentProps<typeof RecordingsTimeline>> = {}) => {
  const onScrubTo = vi.fn(), onSelectionChange = vi.fn();
  render(<RecordingsTimeline day={day} summary={[]} timeline={[]} selectedHour={9} onSelectHour={vi.fn()} onScrubTo={onScrubTo} onSelectionChange={onSelectionChange} {...props} />);
  const ruler = screen.getByTestId("timeline-ruler");
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 128, right: 1000, bottom: 128, x: 0, y: 0, toJSON: () => ({}) });
  return { ruler, onScrubTo, onSelectionChange };
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("continuous archive navigation", () => {
  it("keeps the cursor time fixed while zooming and clamps the day boundaries", () => {
    expect(zoomTimelineViewport({ start: 0, span: 86400 }, 0.5, 0.75)).toEqual({ start: 32400, span: 43200 });
    expect(zoomTimelineViewport({ start: 80000, span: 300 }, 10, 1)).toEqual({ start: 77300, span: 3000 });
    expect(zoomTimelineViewport({ start: 0, span: 300 }, 0.5, 0)).toEqual({ start: 0, span: 300 });
  });
  it("wheel zooms at the mouse and Shift+wheel pans the ruler", () => {
    const { ruler } = setup();
    fireEvent.wheel(ruler, { clientX: 500, deltaY: -100 });
    expect(ruler).toHaveAttribute("data-view-span", "64800");
    expect(ruler).toHaveAttribute("data-view-start", "10800");
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 100, shiftKey: true });
    expect(ruler).toHaveAttribute("data-view-start", "18900");
    fireEvent.click(screen.getByRole("button", { name: "Whole day" }));
    expect(ruler).toHaveAttribute("data-view-span", "86400");
  });
  it("seeks exactly from a click and preserves a dragged export range", () => {
    const { ruler, onScrubTo, onSelectionChange } = setup();
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointerup", 500));
    expect(onScrubTo).toHaveBeenLastCalledWith(43200);
    fireEvent(ruler, pointer("pointerdown", 250));
    fireEvent(ruler, pointer("pointermove", 500));
    fireEvent(ruler, pointer("pointerup", 500));
    expect(onSelectionChange).toHaveBeenCalledWith({ startSec: 21600, endSec: 43200 });
    expect(onScrubTo).toHaveBeenLastCalledWith(21600);
  });
  it("shows exact recorded blocks with a real gap between them", () => {
    setup({ recordings: [segment(timestamp(9), timestamp(9, 10)), segment(timestamp(9, 20), timestamp(9, 30), 5)] });
    const blocks = screen.getAllByTestId("recorded-segment");
    expect(blocks).toHaveLength(2);
    const endOfFirst = Number.parseFloat(blocks[0].style.left) + Number.parseFloat(blocks[0].style.width);
    expect(Number.parseFloat(blocks[1].style.left)).toBeGreaterThan(endOfFirst);
    expect(screen.getAllByTestId("motion-segment")).toHaveLength(1);
  });
  it("jumps to an event outside the selected hour and excludes another day", () => {
    const { onScrubTo } = setup({ timeline: [
      { timestamp: timestamp(15, 10), sourceId: "event", classType: "visible", label: "person", zone: null, score: 0.9 },
      { timestamp: timestamp(15, 10) - 86400, sourceId: "previous-day", classType: "visible", label: "car", zone: null, score: 0.9 },
    ] });
    fireEvent.click(screen.getByRole("button", { name: "person at 15:10" }));
    expect(onScrubTo).toHaveBeenCalledWith(15 * 3600 + 10 * 60);
    expect(screen.queryByRole("button", { name: "car at 00:00" })).toBeNull();
  });
  it("clears an interrupted range when navigating to another day", () => {
    const select = vi.fn();
    const props = { day, summary: [], timeline: [], selectedHour: 9, onSelectHour: vi.fn(), onSelectionChange: select };
    const { rerender } = render(<RecordingsTimeline {...props} />);
    const ruler = screen.getByTestId("timeline-ruler");
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 128, right: 1000, bottom: 128, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent(ruler, pointer("pointerdown", 250));
    fireEvent(ruler, pointer("pointermove", 500));
    rerender(<RecordingsTimeline {...props} day="2026-08-14" />);
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointerup", 500));
    expect(select).not.toHaveBeenCalled();
  });
});

describe.skipIf(Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/Los_Angeles")("daylight saving archive geometry", () => {
  it("keeps footage crossing the repeated clock hour on the 25-hour day", () => {
    const start = new Date("2026-11-01T01:59:50-07:00").getTime() / 1000;
    const end = new Date("2026-11-01T01:00:10-08:00").getTime() / 1000;
    const { ruler } = setup({ day: "2026-11-01", recordings: [segment(start, end)] });
    expect(ruler).toHaveAttribute("data-view-span", "90000");
    expect(screen.getAllByTestId("recorded-segment")).toHaveLength(1);
    expect(Number.parseFloat(screen.getByTestId("recorded-segment").style.width)).toBeGreaterThan(0);
  });
  it("uses a 23-hour ruler when the clock moves forward", () => {
    const { ruler } = setup({ day: "2026-03-08" });
    expect(ruler).toHaveAttribute("data-view-span", "82800");
  });
});
