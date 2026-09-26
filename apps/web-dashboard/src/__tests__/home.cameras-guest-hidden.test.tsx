/**
 * WARP-3157 — the Cameras tile is dropped from the Home board for role
 * `guest` (every camera route refuses that role — showing "No cameras yet"
 * would be a lie about a box that has cameras). Filtered at render time
 * (not out of the WIDGETS registry), so an owner/admin/member's saved
 * layout is unaffected and a guest's own layout edits never strip cameras
 * from someone else's stored preference — the two roles never see the same
 * `items` array.
 *
 * Follows the mocking pattern proven in
 * home.density-option-spacing.test.tsx: BentoBoard/bento-engine mocked out,
 * a minimal WIDGETS registry, matchMedia stubbed for useIsMobile.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { LayoutItem } from "@/components/home/bento-engine";

const authUser = vi.hoisted(() => ({
  current: { username: "sam", role: "guest" as string | undefined },
}));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser.current }),
}));
vi.mock("@/lib/hooks/useBoxAddress", () => ({
  useBoxAddress: () => "droplet.local",
}));
vi.mock("@/lib/api", () => ({ fetchSystemHealth: vi.fn() }));
vi.mock("@/components/home/AmbientLayer", () => ({ AmbientLayer: () => null }));

const bentoBoardMock = vi.fn((_props: { items: LayoutItem[] }) => null);
vi.mock("@/components/home/BentoBoard", () => ({
  BentoBoard: (props: { items: LayoutItem[] }) => bentoBoardMock(props),
}));
vi.mock("@/components/home/bento-engine", () => ({
  fillGaps: (items: unknown[]) => items,
}));
vi.mock("@/components/home/widgets", () => ({
  WIDGETS: {
    chat: { Comp: () => null, icon: () => null, title: "Ask AI" },
    files: { Comp: () => null, icon: () => null, title: "Recent files" },
    cameras: { Comp: () => null, icon: () => null, title: "Cameras" },
  },
  CATALOG: [
    { id: "chat", title: "Ask AI", icon: () => null },
    { id: "files", title: "Recent files", icon: () => null },
    { id: "cameras", title: "Cameras", icon: () => null },
  ],
}));

import DashboardPage from "@/app/page";

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  window.localStorage.clear();
  bentoBoardMock.mockClear();
});

function renderedItemIds(): string[] {
  const call = bentoBoardMock.mock.calls.at(-1);
  const items: LayoutItem[] = call?.[0]?.items ?? [];
  return items.map((it) => it.id);
}

describe("Home board — Cameras tile hidden for guests (WARP-3157)", () => {
  it("never passes the cameras tile to BentoBoard for a guest", () => {
    authUser.current = { username: "sam", role: "guest" };
    render(<DashboardPage />);
    expect(renderedItemIds()).not.toContain("cameras");
    // Everything else in the default layout still renders.
    expect(renderedItemIds()).toContain("chat");
    expect(renderedItemIds()).toContain("files");
  });

  it("keeps the cameras tile for a member", () => {
    authUser.current = { username: "priya", role: "family" };
    render(<DashboardPage />);
    expect(renderedItemIds()).toContain("cameras");
  });

  it("keeps the cameras tile for an owner", () => {
    authUser.current = { username: "stefan", role: "owner" };
    render(<DashboardPage />);
    expect(renderedItemIds()).toContain("cameras");
  });
});
