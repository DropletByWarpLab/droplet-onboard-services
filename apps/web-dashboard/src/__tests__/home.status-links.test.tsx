/**
 * Home tiles that report on another surface are links into it.
 *
 * The System status tile's five stats (Files / Cameras / Devices / AI models
 * / Voice) each open the page they summarise, in BOTH renderings — the 2x2
 * grid of cells and the compact list used when the tile is small — and each
 * camera in the Cameras tile opens /cameras. Previously all of these were
 * inert <div>s: real data with no way to act on it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({ items: [{ path: "/a.txt" }, { path: "/b.txt" }] }),
}));
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({
    models: [{ id: "m1", provider: "ollama", name: "llama3.2" }],
    defaultModel: null,
  }),
}));
vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: [
      { id: "c1", name: "front-door", displayName: "Front door", status: "online" },
      { id: "c2", name: "garage", displayName: "Garage", status: "detecting" },
    ],
    totalCameras: 2,
  }),
}));
vi.mock("@/lib/hooks/useSmartHome", () => ({
  useSmartHome: () => ({ totalDevices: 3 }),
}));
vi.mock("@/lib/hooks/useVoice", () => ({
  useVoiceHealthSummary: () => ({ state: { kind: "off" }, unavailable: false }),
}));
// WARP-3157 — the Voice row (owner/admin only) and the Cameras row (hidden
// for guests) both now read the signed-in role; these link tests exercise
// every stat, so they default to an owner. The role-gating describe block
// below overrides this per test.
const authUser = vi.hoisted(() => ({
  current: { username: "stefan", role: "owner" as string | undefined },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: authUser.current }),
}));

import { WIDGETS } from "@/components/home/widgets";

const StatusTile = WIDGETS.status.Comp;
const CamerasTile = WIDGETS.cameras.Comp;

/** label → route every stat must open. */
const DESTINATIONS: Array<[string, string]> = [
  ["Files", "/files"],
  ["Cameras", "/cameras"],
  ["Devices", "/devices"],
  ["AI models", "/models"],
  ["Voice", "/voice"],
];

beforeEach(() => {
  cleanup();
  pushMock.mockReset();
  authUser.current = { username: "stefan", role: "owner" };
});

describe("System status stats are links", () => {
  it.each(DESTINATIONS)("the %s cell opens %s", (label, href) => {
    render(<StatusTile w={4} h={4} />);
    fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
    expect(pushMock).toHaveBeenCalledWith(href);
  });

  it.each(DESTINATIONS)("the compact %s row opens %s", (label, href) => {
    // w <= 2 selects the compact list rendering.
    render(<StatusTile w={2} h={4} />);
    fireEvent.click(screen.getByRole("button", { name: `Open ${label}` }));
    expect(pushMock).toHaveBeenCalledWith(href);
  });
});

describe("System status row gating (WARP-3157)", () => {
  it("hides the Voice row for a member — GET /api/voice/status is owner/admin only", () => {
    authUser.current = { username: "priya", role: "family" };
    render(<StatusTile w={4} h={4} />);
    expect(screen.queryByRole("button", { name: "Open Voice" })).toBeNull();
    // The other four stats are unaffected.
    expect(screen.getByRole("button", { name: "Open Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Cameras" })).toBeInTheDocument();
  });

  it("hides the Voice row for a guest too", () => {
    authUser.current = { username: "sam", role: "guest" };
    render(<StatusTile w={4} h={4} />);
    expect(screen.queryByRole("button", { name: "Open Voice" })).toBeNull();
  });

  it("hides the Cameras row for a guest — every camera route refuses that role", () => {
    authUser.current = { username: "sam", role: "guest" };
    render(<StatusTile w={4} h={4} />);
    expect(screen.queryByRole("button", { name: "Open Cameras" })).toBeNull();
    // A member still sees it.
    authUser.current = { username: "priya", role: "family" };
    cleanup();
    render(<StatusTile w={4} h={4} />);
    expect(screen.getByRole("button", { name: "Open Cameras" })).toBeInTheDocument();
  });

  it("labels the Files stat 'recent files', not 'recently indexed' (the stat counts recently modified files)", () => {
    render(<StatusTile w={4} h={4} />);
    expect(screen.getByText("recent files")).toBeInTheDocument();
    expect(screen.queryByText("recently indexed")).toBeNull();
  });
});

describe("Camera tiles are links", () => {
  it("tapping a camera opens the Cameras page", () => {
    render(<CamerasTile w={4} h={3} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Front door in Cameras" }),
    );
    expect(pushMock).toHaveBeenCalledWith("/cameras");
  });

  it("every rendered camera is its own tap target", () => {
    render(<CamerasTile w={4} h={3} />);
    expect(
      screen.getAllByRole("button", { name: /in Cameras$/ }),
    ).toHaveLength(2);
  });
});
