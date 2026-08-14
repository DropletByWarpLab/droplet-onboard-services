/**
 * WARP-1549 — <RecentsPage /> attributes rows to their library and routes
 * there.
 *
 * Recents has its own rendering path (rows are bucketed by time into several
 * <FileListSimple /> sections), so the library slot has to be threaded into
 * the grouped listing, not just the degenerate empty one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileEntryInfo, FileSpacesResponse } from "@/lib/types";

const recentsState: { items: FileEntryInfo[] } = { items: [] };

vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({
    items: recentsState.items,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

const SPACES = vi.hoisted<FileSpacesResponse>(() => ({
  sharedAvailable: true,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    {
      id: "shared",
      name: "Household",
      spaceRef: "dept:household",
      root: "/Household",
      kind: "household",
      state: "active",
    },
    {
      id: "dept:finance",
      name: "Finance",
      root: "/Finance",
      kind: "department",
      state: "active",
      right: "contributor",
      isMember: true,
    },
  ],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    fetchSpaces: vi.fn().mockResolvedValue(SPACES),
  };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/files/recents",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

import RecentsPage from "./page";

function file(overrides: Partial<FileEntryInfo>): FileEntryInfo {
  return {
    name: "plan.xlsx",
    path: "/Finance/Q1/plan.xlsx",
    isDirectory: false,
    size: 4096,
    mimeType: null,
    // "now" so the row lands in the Today bucket — a grouped section, which
    // is the code path that has to carry the library slot.
    modifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  pushMock.mockClear();
  recentsState.items = [];
});

describe("<RecentsPage /> — library attribution (WARP-1549)", () => {
  it("labels a library row inside its time bucket", async () => {
    recentsState.items = [file({})];
    render(<RecentsPage />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(await screen.findByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("/Q1")).toBeInTheDocument();
  });

  it("opens a recently-edited library file in its library", async () => {
    recentsState.items = [file({})];
    render(<RecentsPage />);
    await screen.findByText("Finance");

    fireEvent.click(screen.getByText("plan.xlsx"));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/files?space=dept%3Afinance&path=%2FQ1"
      )
    );
  });

  it("routes a Household file with the SPACE-RELATIVE path the page expects", async () => {
    // The orchestrator prefixes the Household mount server-side for
    // `space=shared`, so the home-relative form would double the prefix.
    recentsState.items = [
      file({ name: "italy.pdf", path: "/Household/Trips/italy.pdf" }),
    ];
    render(<RecentsPage />);
    // WARP-1808 — the chip renders the business-facing "Workspace" label while
    // the fixture keeps the raw server name "Household" (data contract).
    await screen.findByText("Workspace");

    fireEvent.click(screen.getByText("italy.pdf"));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/files?space=shared&path=%2FTrips")
    );
  });

  it("leaves personal rows unlabelled and personally routed", async () => {
    recentsState.items = [file({ name: "notes.md", path: "/Documents/notes.md" })];
    render(<RecentsPage />);

    expect(await screen.findByText("/Documents")).toBeInTheDocument();
    expect(screen.queryByText("My Files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("notes.md"));
    expect(pushMock).toHaveBeenCalledWith("/files?path=%2FDocuments");
  });
});
