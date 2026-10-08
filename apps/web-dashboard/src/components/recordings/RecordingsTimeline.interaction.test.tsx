import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordingsTimeline, zoomTimelineViewport } from "./RecordingsTimeline";
import type { RecordingSegment, TimelineEntry } from "@/lib/types";

const day = "2026-08-13";
const timestamp = (hour: number, minute = 0) => new Date(2026, 7, 13, hour, minute).getTime() / 1000;
const segment = (startTime: number, endTime: number, motion = 0): RecordingSegment => ({ id: String(startTime), startTime, endTime, duration: endTime - startTime, motion, objects: 0 });
const setup = (props: Partial<React.ComponentProps<typeof RecordingsTimeline>> = {}) => {
  const onScrubTo = vi.fn(), onSelectionChange = vi.fn();
  const timelineProps = { day, summary: [], timeline: [], selectedHour: 9, onSelectHour: vi.fn(), onScrubTo, onSelectionChange, ...props };
  const utils = render(<RecordingsTimeline {...timelineProps} />);
  const ruler = screen.getByTestId("timeline-ruler");
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 128, right: 1000, bottom: 128, x: 0, y: 0, toJSON: () => ({}) });
  return { ...utils, ruler, onScrubTo, onSelectionChange, props: timelineProps };
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function pointer(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("continuous archive navigation", () => {
  it("spaces narrow ruler labels readably, keeps edge labels inside, and adapts after resize", () => {
    let resize: ResizeObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const { ruler, unmount } = setup({ initialSpanSec: 3900, focusSec: 12 * 3600 + 140 });
    const notifyWidth = (width: number) => act(() => resize([{
      target: ruler,
      contentRect: { width, height: 128, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 128, toJSON: () => ({}) },
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
    }], {} as ResizeObserver));
    notifyWidth(252);
    const narrowLabels = screen.getAllByTestId("time-tick-label");
    expect(narrowLabels).toHaveLength(3);
    expect(narrowLabels[0]).toHaveTextContent("11:30");
    expect(narrowLabels[0].style.transform).toBe("none");
    expect(narrowLabels.at(-1)?.style.transform).toBe("translateX(-100%)");
    const positions = narrowLabels.map((label) => Number.parseFloat(label.parentElement!.style.left) / 100 * 252);
    expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(70);
    notifyWidth(1100);
    expect(screen.getAllByTestId("time-tick-label").length).toBeGreaterThan(narrowLabels.length);
    expect(ruler).toHaveAttribute("data-view-span", "3900");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
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
  it("starts at an hour around the camera focus so scrolling immediately browses time", () => {
    const { ruler } = setup({ initialSpanSec: 3600, focusSec: 12 * 3600, wheelMode: "pan" });
    expect(ruler).toHaveAttribute("data-view-span", "3600");
    expect(ruler).toHaveAttribute("data-view-start", "41400");
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 100 });
    expect(ruler).toHaveAttribute("data-view-start", "41760");
  });
  it("centers explicit focus requests without resetting zoom or following playback ticks", () => {
    const { ruler, rerender, props } = setup({ initialSpanSec: 3600, focusSec: 12 * 3600, wheelMode: "pan" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    expect(ruler).toHaveAttribute("data-view-span", "1800");
    rerender(<RecordingsTimeline {...props} focusSec={15 * 3600} />);
    expect(ruler).toHaveAttribute("data-view-start", "53100");
    expect(ruler).toHaveAttribute("data-view-span", "1800");
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 100 });
    expect(ruler).toHaveAttribute("data-view-start", "53280");
    rerender(<RecordingsTimeline {...props} focusSec={15 * 3600} playheadSec={15 * 3600 + 1} />);
    expect(ruler).toHaveAttribute("data-view-start", "53280");
    rerender(<RecordingsTimeline {...props} focusSec={15 * 3600} focusKey={1} />);
    expect(ruler).toHaveAttribute("data-view-start", "53100");
    expect(ruler).toHaveAttribute("data-view-span", "1800");
  });
  it("brings an externally selected event into view while retaining user zoom", () => {
    const event: TimelineEntry = { timestamp: timestamp(15, 10), sourceId: "selected-event", classType: "visible", label: "person", zone: null, score: 0.9 };
    const { ruler, rerender, props } = setup({ timeline: [event], initialSpanSec: 3600 });
    expect(screen.queryByRole("button", { name: "person at 15:10" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    rerender(<RecordingsTimeline {...props} selectedEventId={event.sourceId} />);
    expect(ruler).toHaveAttribute("data-view-span", "1800");
    expect(ruler).toHaveAttribute("data-view-start", "53700");
    expect(screen.getByRole("button", { name: "person at 15:10" })).toHaveAttribute("aria-pressed", "true");
  });
  it("resets the initial zoom on a different day and clamps focus at day boundaries", () => {
    const { ruler, rerender, props } = setup({ initialSpanSec: 3600, focusSec: 600 });
    expect(ruler).toHaveAttribute("data-view-start", "0");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    rerender(<RecordingsTimeline {...props} day="2026-08-14" focusSec={86100} />);
    expect(ruler).toHaveAttribute("data-view-span", "3600");
    expect(ruler).toHaveAttribute("data-view-start", "82800");
    rerender(<RecordingsTimeline {...props} day="2026-08-15" focusSec={null} />);
    expect(ruler).toHaveAttribute("data-view-span", "3600");
    expect(ruler).toHaveAttribute("data-view-start", "0");
  });
  it("scrolls through time vertically and horizontally in camera pan mode", () => {
    const { ruler } = setup({ wheelMode: "pan" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    const span = Number(ruler.getAttribute("data-view-span"));
    const start = Number(ruler.getAttribute("data-view-start"));
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 100 });
    expect(ruler).toHaveAttribute("data-view-span", String(span));
    expect(ruler).toHaveAttribute("data-view-start", String(start + span / 10));
    fireEvent.wheel(ruler, { clientX: 500, deltaX: -50 });
    expect(ruler).toHaveAttribute("data-view-start", String(start + span / 20));
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 10000 });
    expect(ruler).toHaveAttribute("data-view-start", String(86400 - span));
    fireEvent.wheel(ruler, { clientX: 500, deltaX: -10000 });
    expect(ruler).toHaveAttribute("data-view-start", "0");
  });
  it.each(["ctrlKey", "metaKey"])("zooms under the cursor with %s in camera pan mode", (modifier) => {
    const { ruler } = setup({ wheelMode: "pan" });
    fireEvent.wheel(ruler, { clientX: 500, deltaY: -100, [modifier]: true });
    expect(ruler).toHaveAttribute("data-view-span", "64800");
    expect(ruler).toHaveAttribute("data-view-start", "10800");
  });
  it("ignores zero wheel movement and normalizes line scrolling in pan mode", () => {
    const { ruler } = setup({ wheelMode: "pan" });
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 0, ctrlKey: true });
    expect(ruler).toHaveAttribute("data-view-span", "86400");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    const span = Number(ruler.getAttribute("data-view-span"));
    const start = Number(ruler.getAttribute("data-view-start"));
    fireEvent.wheel(ruler, { clientX: 500, deltaY: 2, deltaMode: 1 });
    expect(ruler).toHaveAttribute("data-view-start", String(start + 32 / 1000 * span));
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
  it("drags the viewport without seeking when range selection is unavailable", () => {
    const { ruler, onScrubTo, onSelectionChange } = setup({ onSelectionChange: undefined, wheelMode: "pan" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    const start = Number(ruler.getAttribute("data-view-start"));
    const span = Number(ruler.getAttribute("data-view-span"));
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointermove", 400));
    expect(ruler).toHaveAttribute("data-view-start", String(start + span / 10));
    fireEvent(ruler, pointer("pointermove", 250));
    expect(ruler).toHaveAttribute("data-view-start", String(start + span / 4));
    fireEvent(ruler, pointer("pointerup", 250));
    expect(onScrubTo).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("selection-band")).toBeNull();
    // A subsequent click still seeks in the viewport that was dragged into view.
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointerup", 500));
    expect(onScrubTo).toHaveBeenCalledWith(start + span / 4 + span / 2);
  });
  it("clamps a dragged viewport and clears a cancelled gesture", () => {
    const { ruler, onScrubTo } = setup({ onSelectionChange: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in timeline" }));
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointermove", -1000));
    expect(ruler).toHaveAttribute("data-view-start", "43200");
    fireEvent(ruler, pointer("pointercancel", -1000));
    fireEvent(ruler, pointer("pointerup", -1000));
    expect(onScrubTo).not.toHaveBeenCalled();
    fireEvent(ruler, pointer("pointerdown", 500));
    fireEvent(ruler, pointer("pointermove", 2000));
    expect(ruler).toHaveAttribute("data-view-start", "0");
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
  it("opens the associated event clip without seeking the continuous archive", () => {
    const event: TimelineEntry = { timestamp: timestamp(15, 10), sourceId: "person-event", classType: "visible", label: "person", zone: "Office", score: 0.9 };
    const another: TimelineEntry = { ...event, timestamp: timestamp(15, 20), sourceId: "other-event" };
    const onSelectEvent = vi.fn(), onSelectHour = vi.fn();
    const { onScrubTo } = setup({ timeline: [event, another], onSelectEvent, onSelectHour, selectedEventId: event.sourceId });
    const marker = screen.getByRole("button", { name: "person at 15:10" });
    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(marker.className).toContain("ring-2");
    expect(screen.getByRole("button", { name: "person at 15:20" })).toHaveAttribute("aria-pressed", "false");
    fireEvent(marker, pointer("pointerdown", 632));
    fireEvent(marker, pointer("pointerup", 632));
    fireEvent.click(marker);
    expect(onSelectEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(onSelectEvent.mock.calls[0][0]).toBe(event);
    expect(onScrubTo).not.toHaveBeenCalled();
    expect(onSelectHour).not.toHaveBeenCalled();
  });
  it("preserves keyboard seeking and zoom controls in camera pan mode", () => {
    const { ruler, onScrubTo } = setup({ wheelMode: "pan", onSelectionChange: undefined });
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onScrubTo).toHaveBeenLastCalledWith(10 * 3600);
    fireEvent.keyDown(slider, { key: "+" });
    expect(ruler).toHaveAttribute("data-view-span", "43200");
    fireEvent.keyDown(slider, { key: "-" });
    expect(ruler).toHaveAttribute("data-view-span", "86400");
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
