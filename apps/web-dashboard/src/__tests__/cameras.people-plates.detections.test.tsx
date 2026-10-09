/**
 * People and Plates used to open straight onto a Frigate roster (known faces,
 * known plates) that is empty on any box with face recognition / LPR off — so
 * clicking People showed nothing even while the main page listed people it had
 * just seen. Both pages now lead with the detections themselves
 * (GET /api/cameras/events?labels=…) and keep the roster below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { EventDetail } from "@/lib/types";
import { CamerasUnavailableError } from "@/lib/files-unavailable";

const api = vi.hoisted(() => ({
  fetchEventsFiltered: vi.fn(),
  fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(),
  fetchCameras: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras/people",
}));
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: "owner" } }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <p>{sub}</p>
      <div>{actions}</div>
      <div data-testid="page-inner">{children}</div>
    </div>
  ),
}));
vi.mock("@/components/events/EventClipModal", () => ({
  EventClipModal: ({ event, cameraName }: { event: EventDetail; cameraName?: string }) => (
    <div data-testid="clip-modal" data-event={event.id} data-camera={cameraName} />
  ),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import PeoplePage from "@/app/cameras/people/page";
import PlatesPage from "@/app/cameras/plates/page";

function event(over: Partial<EventDetail> = {}): EventDetail {
  return {
    id: "evt-1",
    camera: "front_door",
    label: "person",
    score: 0.92,
    startTime: Math.floor(Date.now() / 1000) - 120,
    endTime: Math.floor(Date.now() / 1000) - 100,
    thumbnail: "/api/cameras/events/evt-1/thumbnail",
    hasClip: true,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: "/api/cameras/clips/event/evt-1",
    snapshotUrl: "/api/cameras/events/evt-1/snapshot",
    description: null,
    ...over,
  };
}

const renderPage = (ui: ReactNode) =>
  render(<SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>);

beforeEach(() => {
  api.fetchEventsFiltered.mockReset();
  api.fetchKnownFaces.mockReset().mockResolvedValue([]);
  api.fetchKnownPlates.mockReset().mockResolvedValue([]);
  api.fetchCameras.mockReset().mockResolvedValue([
    { name: "front_door", displayName: "Lobby" },
  ]);
});
afterEach(cleanup);

describe("/cameras/people", () => {
  it("leads with person detections, then the known-faces roster", async () => {
    api.fetchEventsFiltered.mockResolvedValue({
      events: [event({ id: "a" }), event({ id: "b", camera: "garage" })],
      nextCursor: null,
    });
    renderPage(<PeoplePage />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /person/i }).length).toBe(2));
    expect(api.fetchEventsFiltered).toHaveBeenCalledWith({ labels: ["person"], limit: 50 });

    const headings = Array.from(
      screen.getByTestId("page-inner").querySelectorAll("h2"),
      (h) => h.textContent,
    );
    expect(headings[0]).toBe("People detections");
    expect(headings).toContain("Known faces");
    expect(headings.indexOf("People detections")).toBeLessThan(headings.indexOf("Known faces"));
  });

  it("names the camera the way the household did, and opens the clip viewer on click", async () => {
    api.fetchEventsFiltered.mockResolvedValue({ events: [event({ id: "a" })], nextCursor: null });
    renderPage(<PeoplePage />);

    const card = await screen.findByText("Lobby");
    fireEvent.click(card.closest("button") as HTMLElement);
    const modal = screen.getByTestId("clip-modal");
    expect(modal.getAttribute("data-event")).toBe("a");
    expect(modal.getAttribute("data-camera")).toBe("Lobby");
  });

  it("says plainly when nobody has been seen, and still shows the roster state", async () => {
    api.fetchEventsFiltered.mockResolvedValue({ events: [], nextCursor: null });
    renderPage(<PeoplePage />);

    expect(await screen.findByTestId("detections-empty")).toBeTruthy();
    expect(screen.getByText(/no people detected yet/i)).toBeTruthy();
    expect(
      await screen.findByText(/face recognition is off on this droplet, or nobody has been tagged yet/i),
    ).toBeTruthy();
  });

  it("does not call an unreachable camera service 'no people'", async () => {
    api.fetchEventsFiltered.mockRejectedValue(new CamerasUnavailableError());
    renderPage(<PeoplePage />);

    const err = await screen.findByTestId("detections-error");
    expect(err.textContent).toMatch(/camera service is unreachable/i);
    expect(screen.queryByTestId("detections-empty")).toBeNull();
  });

  it("offers a Retry after a failed load that reloads the detections", async () => {
    api.fetchEventsFiltered.mockRejectedValueOnce(new Error("Failed: 500"));
    api.fetchEventsFiltered.mockResolvedValueOnce({ events: [event({ id: "a" })], nextCursor: null });
    renderPage(<PeoplePage />);

    const err = await screen.findByTestId("detections-error");
    expect(err.textContent).toContain("Failed: 500");
    fireEvent.click(within(err).getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Lobby")).toBeTruthy();
    expect(screen.queryByTestId("detections-error")).toBeNull();
  });

  it("the page Refresh button reloads detections as well as the roster", async () => {
    api.fetchEventsFiltered.mockResolvedValue({ events: [], nextCursor: null });
    renderPage(<PeoplePage />);
    await screen.findByTestId("detections-empty");
    expect(api.fetchEventsFiltered).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.fetchEventsFiltered).toHaveBeenCalledTimes(2));
  });
});

describe("/cameras/plates", () => {
  it("leads with vehicle detections and shows the plate when the event carries one", async () => {
    api.fetchEventsFiltered.mockResolvedValue({
      events: [event({ id: "c1", label: "car", subLabel: "ABC-1234" }), event({ id: "c2", label: "car" })],
      nextCursor: null,
    });
    renderPage(<PlatesPage />);

    expect(await screen.findByText(/ABC-1234/)).toBeTruthy();
    expect(api.fetchEventsFiltered).toHaveBeenCalledWith({ labels: ["car"], limit: 50 });
    const headings = Array.from(
      screen.getByTestId("page-inner").querySelectorAll("h2"),
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Vehicle detections", "Known plates"]);
  });

  it("empty: no vehicles, and an honest roster state when plate reading is off", async () => {
    api.fetchEventsFiltered.mockResolvedValue({ events: [], nextCursor: null });
    renderPage(<PlatesPage />);

    expect(await screen.findByText(/no vehicles detected yet/i)).toBeTruthy();
    expect(
      await screen.findByText(/license plate reading is off on this droplet, or no plates have been read yet/i),
    ).toBeTruthy();
  });

  it("says so when the camera service cannot be reached", async () => {
    api.fetchEventsFiltered.mockRejectedValue(new CamerasUnavailableError());
    renderPage(<PlatesPage />);
    expect((await screen.findByTestId("detections-error")).textContent).toMatch(/unreachable/i);
  });
});
