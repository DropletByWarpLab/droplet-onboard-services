/**
 * WARP-941 — <SharedPage /> "Shared by me" tab renders real outbound shares.
 *
 * The tab shipped as a hardcoded "Outbound shares coming soon" placeholder
 * because no reverse-share endpoint existed. Now that the orchestrator
 * exposes GET /api/files/shares-by-me (via useSharedByMe), the tab must:
 *   1. render the user's outbound shares through the same row renderer the
 *      inbound tab uses (recipient + share type + date in the sub line),
 *   2. show an HONEST empty state when there are no outbound shares yet —
 *      never the "coming soon" placeholder,
 *   3. leave the inbound "Shared with me" tab behavior untouched.
 *
 * Data hooks are mocked; the page under test is the real component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ShareDetail } from "@/lib/types";

// ── Data hooks (mutable per-test state) ──
interface HookState {
  items: ShareDetail[];
  isLoading: boolean;
  // WARP-1555 — the page dropped `error` on the floor; the tests below drive it.
  error: unknown;
}
const withMeState: HookState = { items: [], isLoading: false, error: undefined };
const byMeState: HookState = { items: [], isLoading: false, error: undefined };
const withMeRefresh = vi.fn();
const byMeRefresh = vi.fn();

vi.mock("@/lib/hooks/useShares", () => ({
  useSharedWithMe: () => ({
    items: withMeState.items,
    isLoading: withMeState.isLoading,
    error: withMeState.error,
    refresh: withMeRefresh,
  }),
  useSharedByMe: () => ({
    items: byMeState.items,
    isLoading: byMeState.isLoading,
    error: byMeState.error,
    refresh: byMeRefresh,
  }),
}));

// ShellPage's status chip pulls device/health via useDevice (SWR → network).
// Stub it so the page chrome renders without hitting the api in the test env.
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

// Spread the real api module (so every export the page chrome references —
// e.g. ShellPage's fetchSystemHealth — stays defined) but override the
// network-touching calls that fire at render.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    fetchSharedWithMe: vi.fn().mockResolvedValue([]),
    fetchSharedByMe: vi.fn().mockResolvedValue([]),
  };
});

import SharedPage from "./page";

function share(overrides: Partial<ShareDetail>): ShareDetail {
  return {
    id: 1,
    url: null,
    token: null,
    shareType: 0,
    permissions: 1,
    path: "/file.txt",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: null,
    shareWithDisplayName: null,
    uidOwner: null,
    ownerDisplayName: null,
    stime: 1712860391,
    ...overrides,
  };
}

const INBOUND: ShareDetail[] = [
  share({
    id: 10,
    path: "/from-bob.pdf",
    uidOwner: "bob",
    ownerDisplayName: "Bob",
  }),
];

const OUTBOUND: ShareDetail[] = [
  share({
    id: 21,
    path: "/Photos/trip.jpg",
    shareWith: "romain",
    shareWithDisplayName: "Romain",
    uidOwner: "stefan",
    ownerDisplayName: "Stefan",
  }),
  share({
    id: 22,
    shareType: 3,
    path: "/report.pdf",
    url: "http://nextcloud.test/s/abc",
    token: "abc",
  }),
];

function openByMeTab() {
  fireEvent.click(screen.getByRole("button", { name: /shared by me/i }));
}

beforeEach(() => {
  withMeRefresh.mockClear();
  byMeRefresh.mockClear();
  withMeState.items = INBOUND;
  withMeState.isLoading = false;
  withMeState.error = undefined;
  byMeState.items = OUTBOUND;
  byMeState.isLoading = false;
  byMeState.error = undefined;
});

describe("<SharedPage /> — Shared by me (WARP-941)", () => {
  it("renders the outbound shares through the row renderer", () => {
    render(<SharedPage />);
    openByMeTab();

    // Person share row: file name + recipient in the sub line.
    expect(screen.getByText("trip.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Romain/)).toBeInTheDocument();

    // Link share row: file name + an open-link affordance for the URL.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    const openLink = screen.getByRole("link", { name: /open link/i });
    expect(openLink).toHaveAttribute("href", "http://nextcloud.test/s/abc");

    // The placeholder is gone for good.
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it("labels the link-share row for a link audience, not a person", () => {
    render(<SharedPage />);
    openByMeTab();

    expect(screen.getByText(/anyone with the link/i)).toBeInTheDocument();
  });

  it("shows an honest empty state (no 'coming soon') when nothing is shared yet", () => {
    byMeState.items = [];
    render(<SharedPage />);
    openByMeTab();

    expect(screen.getByText(/you haven't shared anything yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    // Copy rule: no exclamation marks in empty states.
    const empty = screen.getByText(/you haven't shared anything yet/i).closest(".empty");
    expect(empty?.textContent).not.toContain("!");
  });

  it("shows a loading state while outbound shares load", () => {
    byMeState.items = [];
    byMeState.isLoading = true;
    render(<SharedPage />);
    openByMeTab();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/you haven't shared anything yet/i)).not.toBeInTheDocument();
  });

  it("keeps the inbound tab intact (default tab, owner shown in sub line)", () => {
    render(<SharedPage />);

    expect(screen.getByText("from-bob.pdf")).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
  });

  it("keeps the inbound empty state on the with-me tab", () => {
    withMeState.items = [];
    render(<SharedPage />);

    expect(screen.getByText(/nothing shared with you yet/i)).toBeInTheDocument();
  });
});

/**
 * WARP-1555 — the page destructured neither hook's `error`, so a failed
 * shares fetch rendered "Nothing shared with you yet" / "You haven't shared
 * anything yet". Both read as a fact about the user's data, not about ours.
 */
describe("<SharedPage /> — fetch failure ≠ nothing shared (WARP-1555)", () => {
  it("renders an error state, never the empty state, on the with-me tab", () => {
    withMeState.items = [];
    withMeState.error = new Error("Failed to fetch shares: 500");
    render(<SharedPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(/couldn't load what's been shared with you/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/nothing shared with you yet/i)).not.toBeInTheDocument();
  });

  it("renders an error state, never the empty state, on the by-me tab", () => {
    byMeState.items = [];
    byMeState.error = new Error("Failed to fetch shares: 500");
    render(<SharedPage />);
    openByMeTab();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load what you've shared/i)).toBeInTheDocument();
    expect(screen.queryByText(/you haven't shared anything yet/i)).not.toBeInTheDocument();
  });

  it("says nothing was unshared, rather than a bare 'something went wrong'", () => {
    withMeState.items = [];
    withMeState.error = new Error("boom");
    render(<SharedPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/nothing has been unshared/i);
    expect(alert.textContent).not.toMatch(/something went wrong/i);
  });

  it("offers a retry that re-runs the failing tab's fetch", () => {
    byMeState.items = [];
    byMeState.error = new Error("boom");
    render(<SharedPage />);
    openByMeTab();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(byMeRefresh).toHaveBeenCalledTimes(1);
    expect(withMeRefresh).not.toHaveBeenCalled();
  });

  it("scopes the failure to the tab that failed", () => {
    // Inbound is fine, outbound is broken: the with-me tab must still list.
    byMeState.items = [];
    byMeState.error = new Error("boom");
    render(<SharedPage />);

    expect(screen.getByText("from-bob.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps showing rows when a background refresh fails", () => {
    withMeState.error = new Error("poll failed");
    render(<SharedPage />);

    expect(screen.getByText("from-bob.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
