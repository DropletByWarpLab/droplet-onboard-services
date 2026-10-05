import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { emptyCameraBusinessHours } from "./camera-business-hours.service.js";

const fetchEventsFiltered = vi.hoisted(() => vi.fn());
const fetchReviews = vi.hoisted(() => vi.fn());
const searchEventsSemantic = vi.hoisted(() => vi.fn());
vi.mock("./frigate.client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./frigate.client.js")>(),
  fetchEventsFiltered, fetchReviews, searchEventsSemantic,
}));
import { getEventsFiltered, getReviewsFiltered, searchEventsSemanticTyped } from "./camera.service.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const hours = emptyCameraBusinessHours();
hours.configured = true;
hours.days.monday = { open: "09:00", close: "17:00" };
const readHours = vi.fn();
const prisma = { systemFlag: { findUnique: readHours } } as unknown as PrismaClient;
const row = (id: string, start: number, camera = "office") => ({
  id, camera, start_time: start, end_time: start + 30, label: "person", severity: "alert", data: {},
});

beforeEach(() => {
  fetchEventsFiltered.mockReset(); fetchReviews.mockReset(); searchEventsSemantic.mockReset();
  readHours.mockReset().mockResolvedValue({ valueJson: hours });
});

describe("camera business hours filtering and pagination", () => {
  it("annotates all list items and leaves unset schedules explicitly unknown", async () => {
    fetchEventsFiltered.mockResolvedValue([row("outside", epoch("2026-10-05T18:00:00Z")), row("inside", epoch("2026-10-05T10:00:00Z"))]);
    const page = await getEventsFiltered({}, "all", prisma);
    expect(page.events.map((event) => event.outsideBusinessHours)).toEqual([true, false]);
    readHours.mockResolvedValue(null);
    const unset = await getEventsFiltered({}, "all", prisma);
    expect(unset.events.every((event) => event.outsideBusinessHours === null)).toBe(true);
  });
  it("scans beyond an entire first batch without matches before paging events", async () => {
    const noon = epoch("2026-10-05T12:00:00Z");
    const first = Array.from({ length: 1000 }, (_, i) => row(`inside-${i}`, noon - i));
    const older = [row("night-1", epoch("2026-10-05T08:00:00Z")), row("night-2", epoch("2026-10-05T07:00:00Z")), row("night-3", epoch("2026-10-05T06:00:00Z"))];
    fetchEventsFiltered.mockResolvedValueOnce(first).mockResolvedValueOnce(older);
    const page = await getEventsFiltered({ businessHours: "outside", limit: 2 }, "all", prisma);
    expect(page.events.map((event) => event.id)).toEqual(["night-1", "night-2"]);
    expect(page.nextCursor).toBe(older[1].start_time);
    expect(fetchEventsFiltered.mock.calls[1][0].before).toBe(noon - 999);
    expect(page.scanLimitReached).toBe(false);
  });
  it("filters reviews server-side and never reveals an out-of-scope camera", async () => {
    fetchReviews.mockResolvedValue([
      row("bedroom", epoch("2026-10-05T08:30:00Z"), "bedroom"),
      row("office", epoch("2026-10-05T08:00:00Z")), row("office-inside", epoch("2026-10-05T10:00:00Z")),
    ]);
    const result = await getReviewsFiltered({ businessHours: "outside" }, new Set(["office"]), prisma);
    expect(result.reviews.map((review) => review.id)).toEqual(["office"]);
    expect(fetchReviews.mock.calls[0][0].cameras).toEqual(["office"]);
    expect(result.reviews[0].outsideBusinessHours).toBe(true);
    expect(result.nextCursor).toBeNull();
  });
  it("returns a continuation when a bounded sparse scan has no matches", async () => {
    const noon = epoch("2026-10-05T12:00:00Z");
    fetchEventsFiltered.mockImplementation(async (filter: { before?: number; limit: number }) => {
      const start = filter.before ?? noon;
      // Fractional timestamps keep all 5000 rows in the same open minute.
      return Array.from({ length: filter.limit }, (_, i) => row(`inside-${start}-${i}`, start - (i + 1) / 1000));
    });
    const result = await getEventsFiltered({ businessHours: "outside" }, "all", prisma);
    expect(result.events).toEqual([]);
    expect(result.scanLimitReached).toBe(true);
    expect(result.nextCursor).toBe(noon - 5);
    expect(fetchEventsFiltered).toHaveBeenCalledTimes(5);
  });
  it("keeps same-time matches together at a numeric cursor boundary", async () => {
    const start = epoch("2026-10-05T08:00:00Z");
    fetchReviews.mockResolvedValue([row("tie-1", start), row("tie-2", start), row("older", start - 60)]);
    const result = await getReviewsFiltered({ businessHours: "outside", limit: 1 }, "all", prisma);
    expect(result.reviews.map((review) => review.id)).toEqual(["tie-1", "tie-2"]);
    expect(result.nextCursor).toBe(start);
  });
  it("reports bounded semantic-search coverage without a misleading time cursor", async () => {
    const start = epoch("2026-10-05T08:00:00Z");
    searchEventsSemantic.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => row(`outside-${i}`, start - i)));
    const result = await searchEventsSemanticTyped({ query: "a person", businessHours: "outside", limit: 2 }, "all", prisma);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((event) => event.outsideBusinessHours)).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.searchLimitReached).toBe(true);
    expect(searchEventsSemantic.mock.calls[0][0].limit).toBe(1000);
  });
  it("classifies spans crossing closing and supports the inside filter", async () => {
    const inside = row("inside", epoch("2026-10-05T16:00:00Z"));
    const crossing = { ...row("crossing", epoch("2026-10-05T16:59:00Z")), end_time: epoch("2026-10-05T17:01:00Z") };
    fetchEventsFiltered.mockResolvedValue([crossing, inside]);
    const result = await getEventsFiltered({ businessHours: "inside" }, "all", prisma);
    expect(result.events.map((event) => event.id)).toEqual(["inside"]);
  });
  it("includes after-hours alerts and detections across batches, excluding in-hours and denied cameras", async () => {
    const late = epoch("2026-10-05T16:30:00Z");
    const first = Array.from({ length: 1000 }, (_, i) => row(`alert-${i}`, late - i));
    const alert = row("alert", epoch("2026-10-05T08:30:00Z"));
    const detection = { ...row("detection", epoch("2026-10-05T08:00:00Z")), severity: "detection" };
    const denied = row("denied-alert", epoch("2026-10-05T08:15:00Z"), "bedroom");
    const older = row("older-alert", epoch("2026-10-05T07:30:00Z"));
    fetchReviews.mockResolvedValueOnce(first).mockResolvedValueOnce([alert, denied, detection, older]);
    const result = await getReviewsFiltered({ severity: ["alert", "detection"], businessHours: "outside", limit: 2 },
      new Set(["office"]), prisma);
    expect(result.reviews.map((review) => review.id)).toEqual(["alert", "detection"]);
    expect(result.reviews.every((review) => review.outsideBusinessHours)).toBe(true);
    expect(result.nextCursor).toBe(detection.start_time);
    expect(fetchReviews.mock.calls[0][0]).toMatchObject({ cameras: ["office"], limit: 1000 });
    expect(fetchReviews.mock.calls[0][0].severity).toBeUndefined();
    expect(fetchReviews.mock.calls[1][0].before).toBe(late - 999);
  });
  it("scans multiple review severities before pagination without requiring saved hours", async () => {
    readHours.mockResolvedValue(null);
    const late = epoch("2026-10-05T19:00:00Z");
    fetchReviews.mockResolvedValueOnce(Array.from({ length: 1000 }, (_, i) => row(`alert-${i}`, late - i, "bedroom")))
      .mockResolvedValueOnce([{ ...row("detection", late - 1100), severity: "detection" }]);
    const result = await getReviewsFiltered({ severity: ["alert", "detection"] }, new Set(["office"]), prisma);
    expect(result.reviews.map((review) => review.id)).toEqual(["detection"]);
    expect(result.reviews[0].outsideBusinessHours).toBeNull();
    expect(fetchReviews).toHaveBeenCalledTimes(2);
    expect(result.nextCursor).toBeNull();
  });
  it("leaves a single upstream severity and ordinary page size unchanged", async () => {
    fetchReviews.mockResolvedValue([row("alert", epoch("2026-10-05T19:00:00Z"))]);
    const result = await getReviewsFiltered({ severity: ["alert"], limit: 7 }, "all", prisma);
    expect(result.reviews[0].severity).toBe("alert");
    expect(fetchReviews.mock.calls[0][0]).toMatchObject({ severity: ["alert"], limit: 7 });
    expect(fetchReviews).toHaveBeenCalledTimes(1);
  });
});
