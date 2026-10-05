/**
 * WARP-3157 — the Cameras tile is dropped from the Home board for role
 * `guest` (every camera route refuses that role — showing "No cameras yet"
 * would be a lie about a box that has cameras). Filtered at render time
 * (not out of the WIDGETS registry), so an owner/admin/member's saved
 * layout is unaffected. The saved layout key is per browser, not per user,
 * so a guest's edit carries the hidden cameras tile through to what it saves
 * rather than stripping it from the next owner's board.
 *
 * Follows the mocking pattern proven in
 * home.density-option-spacing.test.tsx: BentoBoard/bento-engine mocked out,
 * a minimal WIDGETS registry, matchMedia stubbed for useIsMobile.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { LayoutItem } from "@/components/home/bento-engine";

const authUser = vi.hoisted(() => ({
  current: { username: "sam", role: "guest" as string | undefined },
}));
const gateState = vi.hoisted(() => ({
  calendar: "on" as "on" | "off" | "unresolved",
  files: "on" as "on" | "off" | "unresolved",
  cameras: "on" as "on" | "off" | "unresolved",
  network: "on" as "on" | "off" | "unresolved",
  smart_home: "on" as "on" | "off" | "unresolved",
  projects: true,
  mobile: false,
  widgetMounts: { calendar: 0, files: 0, cameras: 0, tasks: 0, remote: 0, scenes: 0 },
}));
vi.mock("swr", () => ({
  default: (key: string) => ({
    data: key === "/api/modules"
      ? { modules: [{ id: "projects", effective: gateState.projects }] }
      : undefined,
  }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser.current }),
  authFetch: vi.fn(),
}));
vi.mock("@/lib/hooks/useModuleGate", () => ({
  MODULE_GATE_KEY: "/api/modules",
  useModuleGateState: (moduleId: string) => gateState[moduleId as "calendar" | "files" | "cameras" | "network" | "smart_home"],
}));
vi.mock("@/lib/hooks/useBoxAddress", () => ({
  useBoxAddress: () => "droplet.local",
}));
vi.mock("@/lib/api", () => ({ fetchSystemHealth: vi.fn() }));
vi.mock("@/components/home/AmbientLayer", () => ({ AmbientLayer: () => null }));

const bentoBoardMock = vi.fn(
  (_props: { items: LayoutItem[]; onChange?: (next: LayoutItem[]) => void }) => null,
);
vi.mock("@/components/home/BentoBoard", () => ({
  BentoBoard: (props: { items: LayoutItem[]; onChange?: (next: LayoutItem[]) => void }) =>
    bentoBoardMock(props),
}));
vi.mock("@/components/home/bento-engine", () => ({
  fillGaps: (items: unknown[]) => items,
}));
vi.mock("@/components/home/widgets", () => ({
  WIDGETS: {
    chat: { Comp: () => null, icon: () => null, title: "Ask AI" },
    calendar: { Comp: () => { gateState.widgetMounts.calendar++; return null; }, icon: () => null, title: "Calendar" },
    files: { Comp: () => { gateState.widgetMounts.files++; return null; }, icon: () => null, title: "Recent files" },
    cameras: { Comp: () => { gateState.widgetMounts.cameras++; return null; }, icon: () => null, title: "Cameras" },
    tasks: { Comp: () => { gateState.widgetMounts.tasks++; return null; }, icon: () => null, title: "Tasks" },
    remote: { Comp: () => { gateState.widgetMounts.remote++; return null; }, icon: () => null, title: "Remote access" },
    scenes: { Comp: () => { gateState.widgetMounts.scenes++; return null; }, icon: () => null, title: "Device control" },
  },
  CATALOG: [
    { id: "chat", title: "Ask AI", icon: () => null },
    { id: "calendar", title: "Calendar", icon: () => null },
    { id: "files", title: "Recent files", icon: () => null },
    { id: "cameras", title: "Cameras", icon: () => null },
    { id: "tasks", title: "Tasks", icon: () => null },
    { id: "remote", title: "Remote access", icon: () => null },
    { id: "scenes", title: "Device control", icon: () => null },
  ],
}));

import DashboardPage from "@/app/page";

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: gateState.mobile,
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
  gateState.calendar = "on";
  gateState.files = "on";
  gateState.cameras = "on";
  gateState.network = "on";
  gateState.smart_home = "on";
  gateState.projects = true;
  gateState.mobile = false;
  gateState.widgetMounts = { calendar: 0, files: 0, cameras: 0, tasks: 0, remote: 0, scenes: 0 };
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

  it("a guest's layout edit keeps the hidden cameras tile in the saved (per-browser) layout", () => {
    authUser.current = { username: "sam", role: "guest" };
    render(<DashboardPage />);
    const props = bentoBoardMock.mock.calls.at(-1)?.[0];
    const guestItems = props?.items ?? [];
    act(() => props?.onChange?.([...guestItems].reverse()));
    const saved = Object.keys(window.localStorage)
      .filter((k) => k.startsWith("droplet-home-bento-v1-") && !k.endsWith("dir"))
      .flatMap((k) => JSON.parse(window.localStorage.getItem(k) ?? "[]") as LayoutItem[])
      .map((it) => it.id);
    expect(saved).toContain("cameras");
    // …and the guest still never sees it.
    expect(renderedItemIds()).not.toContain("cameras");
  });
});

describe("Home board — workspace module gates", () => {
  it("waits for resolved per-person gates and removes off widgets from the Add tray", () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.calendar = "unresolved";
    gateState.files = "off";
    gateState.cameras = "on";
    const { container } = render(<DashboardPage />);

    expect(renderedItemIds()).not.toContain("calendar");
    expect(renderedItemIds()).not.toContain("files");
    expect(renderedItemIds()).toContain("cameras");
    expect(container.querySelector(".dh-tray")?.textContent).not.toContain("Calendar");
    expect(container.querySelector(".dh-tray")?.textContent).not.toContain("Recent files");
  });

  it("preserves hidden layout entries through edits and restores them when enabled", async () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.calendar = "off";
    gateState.files = "off";
    gateState.network = "off";
    gateState.cameras = "on";
    const { rerender } = render(<DashboardPage />);
    const hiddenOrder = ["calendar", "files"];
    const props = bentoBoardMock.mock.calls.at(-1)?.[0];
    act(() => props?.onChange?.([...(props?.items ?? [])].reverse()));

    const saved = JSON.parse(window.localStorage.getItem("droplet-home-bento-v1-balanced") ?? "[]") as LayoutItem[];
    expect(saved.filter((item) => hiddenOrder.includes(item.id)).map((item) => item.id)).toEqual(hiddenOrder);
    expect(renderedItemIds()).not.toContain("calendar");
    expect(renderedItemIds()).not.toContain("files");

    gateState.calendar = "on";
    gateState.files = "on";
    rerender(<DashboardPage />);
    await waitFor(() => {
      expect(renderedItemIds()).toContain("calendar");
      expect(renderedItemIds()).toContain("files");
    });
  });

  it("keeps interleaved hidden entries in stable order when visible widgets are reordered", async () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.calendar = "off";
    gateState.files = "off";
    gateState.network = "off";
    window.localStorage.setItem("droplet-home-bento-v1-migr-remote", "1");
    window.localStorage.setItem(
      "droplet-home-bento-v1-balanced",
      JSON.stringify([
        { id: "calendar", w: 2, h: 2 },
        { id: "chat", w: 2, h: 2 },
        { id: "files", w: 1, h: 3 },
        { id: "cameras", w: 2, h: 2 },
      ]),
    );
    const { rerender } = render(<DashboardPage />);
    await waitFor(() => expect(renderedItemIds()).toEqual(["chat", "cameras"]));

    const props = bentoBoardMock.mock.calls.at(-1)?.[0];
    act(() => props?.onChange?.([...(props?.items ?? [])].reverse()));
    let saved = JSON.parse(window.localStorage.getItem("droplet-home-bento-v1-balanced") ?? "[]") as LayoutItem[];
    expect(saved.map((item) => item.id)).toEqual(["calendar", "cameras", "files", "chat"]);
    expect(saved.find((item) => item.id === "calendar")).toMatchObject({ w: 2, h: 2 });
    expect(saved.find((item) => item.id === "files")).toMatchObject({ w: 1, h: 3 });

    gateState.calendar = "on";
    gateState.files = "on";
    rerender(<DashboardPage />);
    await waitFor(() => expect(renderedItemIds()).toEqual(["calendar", "cameras", "files", "chat"]));
    saved = JSON.parse(window.localStorage.getItem("droplet-home-bento-v1-balanced") ?? "[]") as LayoutItem[];
    expect(saved.filter((item) => item.id === "calendar" || item.id === "files")).toHaveLength(2);
  });

  it("uses the workspace Projects toggle for Tasks without applying a person grant", () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.projects = false;
    const { container, rerender } = render(<DashboardPage />);
    expect(renderedItemIds()).not.toContain("tasks");
    expect(container.querySelector(".dh-tray")?.textContent).not.toContain("Tasks");

    gateState.projects = true;
    rerender(<DashboardPage />);
    expect(renderedItemIds()).toContain("tasks");
  });

  it("hides network and smart-home tiles from the board and Add tray while off", () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.network = "off";
    gateState.smart_home = "unresolved";
    const { container } = render(<DashboardPage />);
    expect(renderedItemIds()).not.toContain("remote");
    expect(renderedItemIds()).not.toContain("scenes");
    expect(container.querySelector(".dh-tray")?.textContent).not.toContain("Remote access");
    expect(container.querySelector(".dh-tray")?.textContent).not.toContain("Device control");
  });

  it("does not mount module polling widgets while their gate is off or unresolved", async () => {
    authUser.current = { username: "priya", role: "family" };
    gateState.mobile = true;
    gateState.calendar = "unresolved";
    gateState.files = "off";
    gateState.cameras = "off";
    gateState.network = "off";
    gateState.smart_home = "off";
    gateState.projects = false;
    const { rerender } = render(<DashboardPage />);

    await waitFor(() => expect(gateState.widgetMounts.calendar).toBe(0));
    expect(gateState.widgetMounts.files).toBe(0);
    expect(gateState.widgetMounts.cameras).toBe(0);
    expect(gateState.widgetMounts.tasks).toBe(0);
    expect(gateState.widgetMounts.remote).toBe(0);
    expect(gateState.widgetMounts.scenes).toBe(0);

    gateState.calendar = "on";
    gateState.files = "on";
    gateState.cameras = "on";
    gateState.network = "on";
    gateState.smart_home = "on";
    gateState.projects = true;
    rerender(<DashboardPage />);
    await waitFor(() => {
      expect(gateState.widgetMounts.calendar).toBeGreaterThan(0);
      expect(gateState.widgetMounts.files).toBeGreaterThan(0);
      expect(gateState.widgetMounts.cameras).toBeGreaterThan(0);
      expect(gateState.widgetMounts.tasks).toBeGreaterThan(0);
      expect(gateState.widgetMounts.remote).toBeGreaterThan(0);
      expect(gateState.widgetMounts.scenes).toBeGreaterThan(0);
    });
  });
});
