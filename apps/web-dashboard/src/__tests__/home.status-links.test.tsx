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

vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({
    models: [{ id: "m1", provider: "ollama", name: "llama3.2" }],
    defaultModel: null,
  }),
}));
// The options each polling hook was last called with, so the gating tests
// can pin that a hidden row's hook also stops polling (WARP-3157: each 403
// writes an audited "Access denied" row).
const hookOpts = vi.hoisted(() => ({
  cameras: undefined as { enabled?: boolean } | undefined,
  voice: undefined as { enabled?: boolean } | undefined,
  files: undefined as { enabled?: boolean } | undefined,
  smartHome: undefined as { enabled?: boolean } | undefined,
  modules: {
    files: "on" as "on" | "off" | "unresolved",
    cameras: "on" as "on" | "off" | "unresolved",
    smart_home: "on" as "on" | "off" | "unresolved",
    voice: "on" as "on" | "off" | "unresolved",
  },
}));
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGateState: (moduleId: string) => hookOpts.modules[moduleId as "files" | "cameras" | "smart_home" | "voice"],
}));
vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: (opts?: { enabled?: boolean }) => (hookOpts.cameras = opts, {
    cameras: [
      { id: "c1", name: "front-door", displayName: "Front door", status: "online" },
      { id: "c2", name: "garage", displayName: "Garage", status: "detecting" },
    ],
    totalCameras: 2,
  }),
}));
vi.mock("@/lib/hooks/useSmartHome", () => ({
  useSmartHome: (opts?: { enabled?: boolean }) => (
    (hookOpts.smartHome = opts), { totalDevices: 3 }
  ),
}));
vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: (_limit: number, opts?: { enabled?: boolean }) => (
    (hookOpts.files = opts), { items: [{ path: "/a.txt" }, { path: "/b.txt" }] }
  ),
}));
vi.mock("@/lib/hooks/useVoice", () => ({
  useVoiceHealthSummary: (opts?: { enabled?: boolean }) => (
    (hookOpts.voice = opts), { state: { kind: "off" }, unavailable: false }
  ),
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
  hookOpts.modules = { files: "on", cameras: "on", smart_home: "on", voice: "on" };
  hookOpts.files = undefined;
  hookOpts.smartHome = undefined;
  hookOpts.cameras = undefined;
  hookOpts.voice = undefined;
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

  it("stops polling what it hides: no voice poll for a member, no camera or voice poll for a guest", () => {
    authUser.current = { username: "priya", role: "family" };
    render(<StatusTile w={4} h={4} />);
    expect(hookOpts.voice).toEqual({ enabled: false });
    expect(hookOpts.cameras).toEqual({ enabled: true });
    cleanup();
    authUser.current = { username: "sam", role: "guest" };
    render(<StatusTile w={4} h={4} />);
    expect(hookOpts.voice).toEqual({ enabled: false });
    expect(hookOpts.cameras).toEqual({ enabled: false });
    cleanup();
    authUser.current = { username: "stefan", role: "owner" };
    render(<StatusTile w={4} h={4} />);
    expect(hookOpts.voice).toEqual({ enabled: true });
    expect(hookOpts.cameras).toEqual({ enabled: true });
  });

  it("labels the Files stat 'recent files', not 'recently indexed' (the stat counts recently modified files)", () => {
    render(<StatusTile w={4} h={4} />);
    expect(screen.getByText("recent files")).toBeInTheDocument();
    expect(screen.queryByText("recently indexed")).toBeNull();
  });

  it("stops each module poll and omits its link while the module is off or unresolved", () => {
    hookOpts.modules = { files: "off", cameras: "unresolved", smart_home: "off", voice: "unresolved" };
    render(<StatusTile w={4} h={4} />);

    expect(hookOpts.files).toEqual({ enabled: false });
    expect(hookOpts.cameras).toEqual({ enabled: false });
    expect(hookOpts.smartHome).toEqual({ enabled: false });
    expect(hookOpts.voice).toEqual({ enabled: false });
    expect(screen.queryByRole("button", { name: "Open Files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Cameras" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Devices" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Voice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open AI models" })).toBeInTheDocument();
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
