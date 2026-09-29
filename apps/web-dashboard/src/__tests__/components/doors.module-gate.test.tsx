/**
 * ADR-055 P4b — Doors is ABSENT when the module is off, on every surface, and
 * present for exactly owners and admins when it is on.
 *
 * The module ships dark: DOORS_ENABLED is off by default and the orchestrator
 * then does not LIST `doors` in GET /api/modules at all (`listedWhenUnavailable:
 * false`). That is a different shape from every other switched-off module,
 * which is listed with `effective: false`, and the client's gate reads "not in
 * the payload" as "a module I can't classify: show it". These cases drive the
 * REAL `isModuleEffective` through every nav surface and the route guard, in
 * every shape the payload can take, so the dark shape can never leave Doors
 * standing on a box that has none.
 *
 *   surfaces: the desktop aside, the More drawer (the bottom bar has no Doors
 *   tab — it is not a primary), the Workspace layout's Operations chip, and
 *   ModuleRouteGuard at /doors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const authRef = { current: { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "owner" as string } };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: authRef.current,
    isLoading: false,
    setupRequired: false,
    login: vi.fn(),
    logout: vi.fn(async () => {}),
    completeSetup: vi.fn(),
  }),
}));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceType: "business" as const, isBusiness: true }) }));

const pathnameRef = { current: "/" };
vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => pathnameRef.current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  };
});
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});
vi.mock("@/lib/hooks/useCapabilities", () => ({ useCapabilities: () => ({ claudeActivity: false, ragEval: false }) }));

// The REAL decision over a payload the test controls — the point of this file.
const payloadRef = { current: undefined as import("@/lib/hooks/useModuleGate").ModulesView | undefined };
vi.mock("@/lib/hooks/useModuleGate", async (orig) => {
  const actual = await orig<typeof import("@/lib/hooks/useModuleGate")>();
  return { ...actual, useModuleGate: () => (moduleId: string) => actual.isModuleEffective(payloadRef.current, moduleId) };
});

import { Sidebar } from "@/components/Sidebar";
import { ModuleRouteGuard } from "@/components/ModuleRouteGuard";
import { NAV_GROUPS, moduleForPath, visibleItems, type AuthRole } from "@/components/nav-config";
import { resolveSpaces } from "@/components/workspace/workspace-nav-config";
import { isModuleEffective, type ModulesView } from "@/lib/hooks/useModuleGate";

const NO_CAPS = { claudeActivity: false, ragEval: false, medicalConnector: false };

/** DOORS_ENABLED on, and the person holds Doors. */
const ON: ModulesView = {
  modules: [
    { id: "security", effective: true },
    { id: "doors", effective: true },
  ],
  effectiveForUser: [
    { moduleId: "security", level: "manage" },
    { moduleId: "doors", level: "view" },
  ],
};
/** DOORS_ENABLED off: `doors` is in neither list (listedWhenUnavailable: false). */
const ABSENT: ModulesView = {
  modules: [{ id: "security", effective: true }],
  effectiveForUser: [{ moduleId: "security", level: "manage" }],
};
/** Off AND the caller could not be resolved, so the payload carries no per-user set. */
const ABSENT_NO_PER_USER_SET: ModulesView = { modules: [{ id: "security", effective: true }] };
/** The flag is on, and the owner has not switched the module on (or has switched it off). */
const SWITCHED_OFF: ModulesView = {
  modules: [
    { id: "security", effective: true },
    { id: "doors", effective: false },
  ],
  effectiveForUser: [{ moduleId: "security", level: "manage" }],
};

const OFF_SHAPES: ReadonlyArray<readonly [string, ModulesView]> = [
  ["absent (DOORS_ENABLED off)", ABSENT],
  ["absent, and no per-user set in the payload", ABSENT_NO_PER_USER_SET],
  ["listed but switched off", SWITCHED_OFF],
];

function desktopAside(): HTMLElement {
  const aside = document.querySelector("aside[aria-label='Primary navigation']") as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}
const bottomBar = () => screen.getByRole("navigation", { name: /bottom navigation/i });
function openDrawer(): HTMLElement {
  fireEvent.click(within(bottomBar()).getByRole("button", { name: /more/i }));
  return screen.getByRole("dialog");
}
const doorsLink = (root: HTMLElement) => within(root).queryByRole("link", { name: /^doors$/i });

function guardAt(path: string) {
  pathnameRef.current = path;
  return render(
    <ModuleRouteGuard>
      <div data-testid="page-content">Doors page</div>
    </ModuleRouteGuard>,
  );
}

const systemsItems = () => NAV_GROUPS.find((g) => g.label === "Systems")!.items;
const isOn = (payload: ModulesView | undefined) => (id: string) => isModuleEffective(payload, id);
const opsHrefs = (role: AuthRole, payload: ModulesView | undefined) =>
  resolveSpaces(role, NO_CAPS, isOn(payload))
    .find((s) => s.def.id === "ops")
    ?.destinations.map((d) => d.item.href) ?? [];

beforeEach(() => {
  payloadRef.current = ON;
  pathnameRef.current = "/";
  authRef.current = { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "owner" };
});

describe("the nav definition", () => {
  it("claims /doors and its sub-paths for the `doors` module, with the section's own glyph", () => {
    for (const path of ["/doors", "/doors/anything"]) {
      const gated = moduleForPath(path);
      expect(gated?.moduleId, path).toBe("doors");
      expect(gated?.label, path).toBe("Doors");
      expect(gated?.icon, path).toBeDefined();
    }
  });

  it("is an owner/admin row: the API's read floor is admin, so nothing below is offered a page that would refuse them", () => {
    const item = systemsItems().find((i) => i.href === "/doors")!;
    expect(item.roles).toEqual(["owner", "admin"]);
    expect(item.requiresModule).toBe("doors");
    expect(item.hidden).toBeUndefined();
  });
});

describe("module ON", () => {
  it.each(["owner", "admin"] as const)("a %s sees Doors in the desktop aside, the More drawer and the Workspace chips", (role) => {
    authRef.current = { ...authRef.current, role };
    render(<Sidebar />);
    expect(doorsLink(desktopAside())).toHaveAttribute("href", "/doors");
    expect(doorsLink(openDrawer())).toHaveAttribute("href", "/doors");
    expect(opsHrefs(role, ON)).toContain("/doors");
  });

  it("the bottom tab bar has no Doors tab: it is not one of the four primaries", () => {
    render(<Sidebar />);
    expect(doorsLink(bottomBar())).toBeNull();
  });

  it.each(["family", "guest"] as const)("a %s sees Doors nowhere, even with the module on (the API would refuse them)", (role) => {
    authRef.current = { ...authRef.current, role };
    render(<Sidebar />);
    expect(doorsLink(desktopAside())).toBeNull();
    expect(doorsLink(openDrawer())).toBeNull();
    expect(opsHrefs(role, ON)).not.toContain("/doors");
  });

  it("the route guard lets /doors render", () => {
    guardAt("/doors");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(screen.queryByTestId("module-route-blocked")).toBeNull();
  });
});

describe.each(OFF_SHAPES)("module OFF — %s", (_name, payload) => {
  beforeEach(() => {
    payloadRef.current = payload;
  });

  it("no nav entry on any surface, for an owner", () => {
    render(<Sidebar />);
    expect(doorsLink(desktopAside())).toBeNull();
    expect(doorsLink(openDrawer())).toBeNull();
    expect(opsHrefs("owner", payload)).not.toContain("/doors");
    expect(visibleItems(systemsItems(), "owner", NO_CAPS, isOn(payload)).map((i) => i.href)).not.toContain("/doors");
  });

  it("the page is not rendered: the route guard shows its standard card in its place", () => {
    guardAt("/doors");
    expect(screen.queryByTestId("page-content")).toBeNull();
    expect(screen.getByTestId("module-route-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /doors isn.t available/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /overview/i })).toHaveAttribute("href", "/");
  });

  it("a deep path under /doors is blocked too", () => {
    guardAt("/doors/anything");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });
});

describe("module OFF must not spill onto the neighbours", () => {
  it("Security, on the same payload, is still there", () => {
    payloadRef.current = ABSENT;
    render(<Sidebar />);
    expect(within(desktopAside()).getByRole("link", { name: /^security$/i })).toHaveAttribute("href", "/security");
    expect(opsHrefs("owner", ABSENT)).toContain("/security");
  });
});

describe("the probe has not answered", () => {
  it("fails OPEN, as it does for every module: a blip must never blank a page a box has", () => {
    payloadRef.current = undefined;
    guardAt("/doors");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });
});
