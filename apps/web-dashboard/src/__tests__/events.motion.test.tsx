import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MotionActivity, MotionFilter } from "@/lib/types";
import EventsPage from "@/app/events/page";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "family" } }) }));
vi.mock("@/components/shell/ShellPage", () => ({ ShellPage: ({ children, sub, actions }: { children: ReactNode; sub: string; actions: ReactNode }) => <div><p>{sub}</p>{actions}{children}</div> }));
vi.mock("@/lib/hooks/useCameras", () => ({ useCameras: () => ({ cameras: [] }) }));
vi.mock("@/lib/hooks/useCameraBusinessHours", () => ({ useCameraBusinessHours: () => ({ schedule: { configured: true, timezone: "UTC", days: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } }, error: undefined, isLoading: false, save: vi.fn(), retry: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ searchEventsSemantic: vi.fn(), setEventRetain: vi.fn() }));
const emptyReviews = () => ({ events: [], reviews: [], isLoading: false, isLoadingMore: false, hasMore: false, error: undefined, refresh: vi.fn(), loadMore: vi.fn(), markViewed: vi.fn() });
vi.mock("@/lib/hooks/useEvents", () => ({ useEvents: () => emptyReviews() }));
vi.mock("@/lib/hooks/useReviews", () => ({ useReviews: () => emptyReviews() }));
vi.mock("@/components/recordings/HlsPlayer", () => ({ HlsPlayer: ({ src }: { src: string }) => <div data-testid="motion-player" data-src={src}>Player</div> }));

const start = new Date(2026, 9, 4, 20).getTime() / 1000;
const movement: MotionActivity = { id: "raw-motion-1", camera: "office", startTime: start, endTime: start + 10, motion: 3, outsideBusinessHours: true, playbackUrl: `/api/cameras/office/playback.m3u8?after=${start}&before=${start + 10}` };
let activity: MotionActivity[];
let partial: boolean;
let available: boolean;
let hasMore: boolean;
let filters: MotionFilter[];
const loadMore = vi.fn();
vi.mock("@/lib/hooks/useMotionActivity", () => ({ useMotionActivity: (filter: MotionFilter) => {
  filters.push(filter);
  return { activity, coverage: { after: filter.after, before: filter.before, partial, cameras: [{ camera: "office", recordedSeconds: available ? 600 : null, hasGaps: true, available }] }, isLoading: false, isLoadingMore: false, error: undefined, hasMore, refresh: vi.fn(), loadMore };
} }));

beforeEach(() => { activity = [movement]; partial = true; available = true; hasMore = false; filters = []; loadMore.mockReset(); });
afterEach(cleanup);

describe("actual recorded movement", () => {
  it("keeps motion separate from review status, discloses recording gaps, and plays its bounded recording", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Outside hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(filters.at(-1)?.businessHours).toBe("outside");
    expect(screen.queryByRole("button", { name: "Unreviewed" })).not.toBeInTheDocument();
    expect(screen.getByText(/Movement may have occurred in those gaps/)).toBeInTheDocument();
    expect(screen.getByText("1 movement period in this view.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse recording" })).toHaveAttribute("href", "/cameras/office/recordings?date=2026-10-04");
    fireEvent.click(screen.getByRole("button", { name: /Play movement/ }));
    expect(screen.getByTestId("motion-player")).toHaveAttribute("data-src", movement.playbackUrl);
  });

  it("lets a calendar day select exact local midnight boundaries without changing them for filters", () => {
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Motion time range" }), { target: { value: "day" } });
    fireEvent.change(screen.getByLabelText("Motion date"), { target: { value: "2026-03-08" } });
    const selected = filters.at(-1)!;
    expect(selected.after).toBe(new Date(2026, 2, 8).getTime() / 1000);
    expect(selected.before).toBe(new Date(2026, 2, 9).getTime() / 1000);
    fireEvent.click(screen.getByRole("button", { name: "Outside hours" }));
    expect(filters.at(-1)).toMatchObject({ after: selected.after, before: selected.before, businessHours: "outside" });
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByLabelText("Motion date")).toHaveValue("2026-03-08");
  });

  it("keeps pagination reachable for empty motion results and warns about gaps even if partial is false", () => {
    activity = []; hasMore = true; partial = false;
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByText(/Movement may have occurred in those gaps/)).toBeInTheDocument();
    expect(screen.queryByText("All clear")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("does not claim no after-hours movement when all motion cameras are unavailable", () => {
    activity = []; available = false;
    render(<EventsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByText(/Motion could not be checked for these cameras/)).toBeInTheDocument();
    expect(screen.getByText(/After-hours activity is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/0 outside business hours/)).not.toBeInTheDocument();
  });
});
