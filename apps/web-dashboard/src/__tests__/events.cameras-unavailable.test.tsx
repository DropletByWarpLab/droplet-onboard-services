/**
 * WARP-3105 — a Frigate outage is a 200 + empty list the box marks
 * `X-Droplet-Degraded: frigate-unavailable`. The Events page must say the
 * cameras are unavailable (with Retry), never "No events yet" / "All clear";
 * an unmarked empty answer still reads as empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

import { fetchEventsFiltered, fetchReviewsFiltered } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import {
  CamerasUnavailableError,
  isCamerasUnavailableError,
} from "@/lib/files-unavailable";

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/hooks/useCameras", () => ({ useCameras: () => ({ cameras: [] }) }));

const refresh = vi.fn();
let hookError: unknown = undefined;
const hook = () => ({
  events: [],
  reviews: [],
  isLoading: false,
  isLoadingMore: false,
  error: hookError,
  hasMore: false,
  loadMore: vi.fn(),
  refresh,
  markViewed: vi.fn(),
});
vi.mock("@/lib/hooks/useEvents", () => ({ useEvents: () => hook() }));
vi.mock("@/lib/hooks/useReviews", () => ({ useReviews: () => hook() }));

import EventsPage from "@/app/events/page";

const authFetchMock = vi.mocked(authFetch);

function res(body: unknown, degraded: boolean): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: degraded ? { "X-Droplet-Degraded": "frigate-unavailable" } : {},
  });
}

beforeEach(() => {
  authFetchMock.mockReset();
  refresh.mockReset();
  hookError = undefined;
});
afterEach(cleanup);

describe.each([
  ["fetchEventsFiltered", () => fetchEventsFiltered({}), { events: [], nextCursor: null }],
  ["fetchReviewsFiltered", () => fetchReviewsFiltered({}), { reviews: [], nextCursor: null }],
] as const)("%s", (_name, call, body) => {
  it("throws CamerasUnavailableError on a degraded answer", async () => {
    authFetchMock.mockResolvedValueOnce(res(body, true));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CamerasUnavailableError);
    expect(isCamerasUnavailableError(err)).toBe(true);
  });

  it("resolves a healthy empty answer as-is", async () => {
    authFetchMock.mockResolvedValueOnce(res(body, false));
    await expect(call()).resolves.toEqual(body);
  });
});

describe("Events page", () => {
  it("shows 'Cameras are unavailable' + Retry when the box is degraded", () => {
    hookError = new CamerasUnavailableError();
    render(<EventsPage />);
    expect(screen.getByText("Cameras are unavailable right now.")).toBeTruthy();
    expect(screen.getByText("Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("All clear")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the empty state on a healthy empty result", () => {
    render(<EventsPage />);
    expect(screen.getByText("All clear")).toBeTruthy();
    expect(screen.queryByText("Cameras are unavailable right now.")).toBeNull();
  });
});
