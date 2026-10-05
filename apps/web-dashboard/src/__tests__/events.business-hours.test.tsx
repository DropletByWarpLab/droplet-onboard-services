import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CameraBusinessHours, EventFilter, ReviewFilter } from "@/lib/types";
import { searchEventsSemantic } from "@/lib/api";
import EventsPage from "@/app/events/page";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("@/components/shell/ShellPage", () => ({ ShellPage: ({ children, sub }: { children: ReactNode; sub: string }) => <div><p>{sub}</p>{children}</div> }));
vi.mock("@/lib/hooks/useCameras", () => ({ useCameras: () => ({ cameras: [] }) }));
vi.mock("@/lib/hooks/useMotionActivity", () => ({ useMotionActivity: () => ({ activity: [], coverage: undefined, isLoading: false, isLoadingMore: false, hasMore: false, error: undefined, refresh: vi.fn(), loadMore: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ searchEventsSemantic: vi.fn(), setEventRetain: vi.fn() }));
vi.mock("@/components/events/EventCard", () => ({ EventCard: ({ event }: { event: { id: string } }) => <span>{event.id}</span> }));
vi.mock("@/components/events/ReviewCard", () => ({ ReviewCard: ({ review }: { review: { id: string } }) => <span>{review.id}</span> }));

let schedule: CameraBusinessHours;
let scanCapped = false;
let reviewFilters: ReviewFilter[] = [];
let eventFilters: EventFilter[] = [];
let scheduleKeys: Array<string | undefined> = [];
const loadMore = vi.fn();
const refresh = vi.fn();
const rows = [{ id: "outside-result", camera: "front_door", label: "person", outsideBusinessHours: true, hasBeenReviewed: false }, { id: "inside-result", camera: "front_door", label: "car", outsideBusinessHours: false, hasBeenReviewed: false }];
const matching = (scope: "inside" | "outside" | undefined) => rows.filter((r) => !scope || r.outsideBusinessHours === (scope === "outside"));
vi.mock("@/lib/hooks/useCameraBusinessHours", () => ({ useCameraBusinessHours: () => ({ schedule, error: undefined, isLoading: false, save: vi.fn(), retry: vi.fn() }) }));
vi.mock("@/lib/hooks/useEvents", () => ({ useEvents: (filter: EventFilter, key?: string) => {
  eventFilters.push(filter);
  scheduleKeys.push(key);
  return { events: matching(filter.businessHours), isLoading: false, isLoadingMore: false, hasMore: false, error: undefined, refresh, loadMore };
} }));
vi.mock("@/lib/hooks/useReviews", () => ({ useReviews: (filter: ReviewFilter, key?: string) => {
  reviewFilters.push(filter);
  scheduleKeys.push(key);
  return { reviews: scanCapped ? [] : matching(filter.businessHours), isLoading: false, isLoadingMore: false, hasMore: scanCapped, scanLimitReached: scanCapped, error: undefined, refresh, loadMore, markViewed: vi.fn() };
} }));

beforeEach(() => {
  schedule = { configured: true, timezone: "America/Los_Angeles", days: { monday: { open: "09:00", close: "17:00" }, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } };
  scanCapped = false;
  reviewFilters = [];
  eventFilters = [];
  scheduleKeys = [];
  loadMore.mockReset();
  vi.mocked(searchEventsSemantic).mockReset();
});
afterEach(cleanup);

describe("business hours on the events page", () => {
  it("keeps the hours scope when switching alerts, detections and events, with counts from displayed rows", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Outside hours" }));
    expect(screen.queryByText("inside-result")).not.toBeInTheDocument();
    expect(screen.getByText(/1 outside business hours in 1 loaded results/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Detections/ }));
    expect(screen.getByRole("button", { name: "Outside hours" })).toHaveAttribute("aria-pressed", "true");
    expect(reviewFilters.at(-1)).toMatchObject({ severity: ["detection"], businessHours: "outside" });
    fireEvent.click(screen.getByRole("button", { name: "All events" }));
    expect(eventFilters.at(-1)).toMatchObject({ businessHours: "outside" });
    expect(screen.getByText("1 event in this view.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("inside-result")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All activity" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Load more reachable for an empty capped scan and does not claim all clear", () => {
    scanCapped = true;
    render(<EventsPage />);
    expect(screen.queryByText("All clear")).not.toBeInTheDocument();
    expect(screen.getByText("More activity may be available; load more to check older activity.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("keeps the detection severity while preserving status and time filters", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Detections/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unreviewed" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "24h" } });
    fireEvent.click(screen.getByRole("button", { name: "Outside hours" }));
    expect(reviewFilters.at(-1)).toMatchObject({ severity: ["detection"], reviewed: false, businessHours: "outside", after: expect.any(Number) });
  });

  it("counts semantic results, passes hours scope to search, and discloses capped ranked results", async () => {
    vi.mocked(searchEventsSemantic).mockResolvedValue({ events: [rows[0] as never], nextCursor: null, searchLimitReached: true });
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Outside hours" }));
    fireEvent.click(screen.getByRole("button", { name: "All events" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "person at night" } });
    await waitFor(() => expect(searchEventsSemantic).toHaveBeenCalledWith("person at night", expect.objectContaining({ businessHours: "outside" })));
    expect(await screen.findByText("Search is limited to the top matches; narrow your search or filters.")).toBeInTheDocument();
    expect(screen.getByText("1 event in this view.")).toBeInTheDocument();
    expect(screen.getByText(/1 outside business hours in 1 loaded results/)).toBeInTheDocument();
  });

  it("rekeys all activity caches when the saved timezone changes", () => {
    const { rerender } = render(<EventsPage />);
    const previousKey = scheduleKeys.at(-1);
    schedule = { ...schedule, timezone: "America/Chicago" };
    rerender(<EventsPage />);
    expect(scheduleKeys.at(-1)).not.toBe(previousKey);
    expect(scheduleKeys.at(-1)).toContain("America/Chicago");
  });
});
