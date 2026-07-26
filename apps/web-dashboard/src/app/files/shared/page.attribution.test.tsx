/**
 * WARP-1549 — <SharedPage /> stops throwing the parent path away.
 *
 * The shared rows are hand-rolled and rendered the file name as
 * `share.path.split("/").pop()` — every share of a file called "plan.xlsx"
 * looked identical, and nothing said which library it came from. Both tabs
 * carry paths relative to the CURRENT user's home (inbound rows are the
 * recipient's own mount target), so both resolve against this viewer's spaces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileSpacesResponse, ShareDetail } from "@/lib/types";

const withMeState: { items: ShareDetail[] } = { items: [] };
const byMeState: { items: ShareDetail[] } = { items: [] };

vi.mock("@/lib/hooks/useShares", () => ({
  useSharedWithMe: () => ({
    items: withMeState.items,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
  useSharedByMe: () => ({
    items: byMeState.items,
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
  sharedAvailable: false,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
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
    fetchSharedWithMe: vi.fn().mockResolvedValue([]),
    fetchSharedByMe: vi.fn().mockResolvedValue([]),
    fetchSpaces: vi.fn().mockResolvedValue(SPACES),
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
    path: "/Finance/Q1/plan.xlsx",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: null,
    shareWithDisplayName: "Camille",
    uidOwner: null,
    ownerDisplayName: "Camille",
    stime: null,
    ...overrides,
  };
}

beforeEach(() => {
  withMeState.items = [];
  byMeState.items = [];
});

describe("<SharedPage /> — library attribution (WARP-1549)", () => {
  it("names the library an inbound share lives in", async () => {
    withMeState.items = [share({})];
    render(<SharedPage />);

    expect(await screen.findByText("Finance")).toBeInTheDocument();
  });

  it("brings back the parent path the row used to discard", async () => {
    withMeState.items = [share({})];
    render(<SharedPage />);

    await screen.findByText("Finance");
    expect(screen.getByText(/\/Q1/)).toBeInTheDocument();
  });

  it("attributes outbound shares on the 'Shared by me' tab too", async () => {
    byMeState.items = [share({ id: 2, path: "/Finance/Contracts/msa.pdf" })];
    render(<SharedPage />);

    fireEvent.click(screen.getByRole("button", { name: /shared by me/i }));
    expect(await screen.findByText("Finance")).toBeInTheDocument();
  });

  it("says nothing about a personal share", async () => {
    withMeState.items = [share({ path: "/Documents/budget.xlsx" })];
    render(<SharedPage />);

    expect(await screen.findByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("My Files")).not.toBeInTheDocument();
  });

  it("keeps rendering a share whose path is empty", async () => {
    // Defensive: an OCS record with no path must not blow up the listing.
    withMeState.items = [share({ path: "" })];
    render(<SharedPage />);

    expect(await screen.findByText("Shared item")).toBeInTheDocument();
  });
});
