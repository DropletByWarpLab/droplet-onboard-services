/**
 * WARP-1549 — <TrashPage /> attributes deleted items to the library they came
 * out of.
 *
 * Trash's "Original location" column showed a bare home-relative folder, so
 * two same-named folders in two libraries were indistinguishable — and the
 * next thing a user does with that row is decide whether to restore it.
 *
 * The revoked-library case is asserted here as well as in the resolver's own
 * tests, because Trash is where a wrong label does the most damage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileSpacesResponse, TrashItemInfo } from "@/lib/types";

const trashState: { items: TrashItemInfo[] } = { items: [] };

vi.mock("@/lib/hooks/useTrash", () => ({
  useTrash: () => ({
    items: trashState.items,
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

// Note what is NOT here: the Finance library. This viewer's membership was
// revoked (or never existed) — a deleted "/Finance/Q1/plan.xlsx" must not be
// re-badged as personal just because its library is no longer visible.
const SPACES = vi.hoisted<FileSpacesResponse>(() => ({
  sharedAvailable: false,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    {
      id: "dept:legal",
      name: "Legal",
      root: "/Legal",
      kind: "department",
      state: "active",
      right: "manager",
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

import TrashPage from "./page";

function trashed(overrides: Partial<TrashItemInfo>): TrashItemInfo {
  return {
    name: "msa.pdf.d1712860391",
    originalName: "msa.pdf",
    originalLocation: "/Legal/Contracts",
    size: 1024,
    deletedAt: "2026-07-20T10:00:00.000Z",
    isDirectory: false,
    ...overrides,
  };
}

beforeEach(() => {
  trashState.items = [];
});

describe("<TrashPage /> — library attribution (WARP-1549)", () => {
  it("names the library a deleted item came out of", async () => {
    trashState.items = [trashed({})];
    render(<TrashPage />);

    expect(await screen.findByText("Legal")).toBeInTheDocument();
  });

  it("shows the original location inside that library, not the doubled mount", async () => {
    trashState.items = [trashed({})];
    render(<TrashPage />);

    await screen.findByText("Legal");
    expect(screen.getByText("/Contracts")).toBeInTheDocument();
    expect(screen.queryByText("/Legal/Contracts")).not.toBeInTheDocument();
  });

  it("leaves a personal item's location exactly as it was", async () => {
    trashState.items = [
      trashed({ originalName: "budget.xlsx", originalLocation: "/Documents" }),
    ];
    render(<TrashPage />);

    expect(await screen.findByText("/Documents")).toBeInTheDocument();
    expect(screen.queryByText("My Files")).not.toBeInTheDocument();
  });

  it("does NOT relabel an item from a no-longer-visible library as personal", async () => {
    trashState.items = [
      trashed({ originalName: "plan.xlsx", originalLocation: "/Finance/Q1" }),
    ];
    render(<TrashPage />);

    // Degrades to the unattributed status quo: the raw path, no library claim.
    expect(await screen.findByText("/Finance/Q1")).toBeInTheDocument();
    expect(screen.queryByText("My Files")).not.toBeInTheDocument();
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
  });

  it("keeps the column labelled 'Original location'", async () => {
    trashState.items = [trashed({})];
    render(<TrashPage />);

    expect(await screen.findByText("Original location")).toBeInTheDocument();
  });
});
