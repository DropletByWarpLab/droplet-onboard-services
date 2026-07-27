/**
 * WARP-1528 / ADR-032 §3(a) + design §9 note (a) — the three nav-gate gaps.
 *
 * The App-Modules nav gate shipped workspace-wide (WARP-1397) with three known
 * holes the 2026-07-24 grounding named. This suite pins two of them closed
 * (the third, the fail-open client hook, is ModuleRouteGuard.test.tsx):
 *
 *   (a) a CHILD item's `requiresModule` / `roles` was a documented no-op —
 *       children rode their parent's visibility wholesale, so a sub-destination
 *       could never be gated on its own;
 *   (b) the Integrations top-level item carried NO gate at all while the
 *       orchestrator's erp.ts gates owner/admin — the nav advertised a surface
 *       the box refuses.
 *
 * And design §9 note (a): a denied module must vanish from ALL THREE nav
 * surfaces — desktop aside, mobile bottom tab bar, More drawer. The bottom bar
 * is built separately and is the historically-missed one, so it gets its own
 * assertion rather than riding a document-wide query.
 *
 * Gap (a) is pinned against the exported pure predicate as well as the rendered
 * nav: no production child needs a distinct module gate TODAY, and inventing a
 * module id to prove the mechanism would fork the one feature vocabulary. The
 * predicate test proves the machinery; the render tests prove the real gates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { FolderOpen } from "lucide-react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const authRef = {
  current: {
    id: "u1",
    username: "ada",
    displayName: "Ada Lovelace",
    role: "owner" as string,
  },
};
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

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceType: "business" as const, isBusiness: true }),
}));

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

vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));

// Drive the gate directly — fail-open semantics (a module is on unless
// positively reported off) match the real hook.
const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (moduleId: string) => modulesRef.current[moduleId] !== false,
}));

import { Sidebar } from "@/components/Sidebar";
import { visibleItems, type NavItem } from "@/components/nav-config";

function desktopAside(): HTMLElement {
  const aside = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}

function bottomBar(): HTMLElement {
  return screen.getByRole("navigation", { name: /bottom navigation/i });
}

function openDrawer(): HTMLElement {
  fireEvent.click(within(bottomBar()).getByRole("button", { name: /more/i }));
  return screen.getByRole("dialog");
}

const NO_CAPS = { claudeActivity: false, ragEval: false };
const allOn = () => true;

beforeEach(() => {
  modulesRef.current = {};
  pathnameRef.current = "/";
  authRef.current = {
    id: "u1",
    username: "ada",
    displayName: "Ada Lovelace",
    role: "owner",
  };
});

describe("gap (a) — a child item's own gate is no longer a no-op", () => {
  const parent = (children: NavItem[]): NavItem[] => [
    { href: "/files", label: "Files", icon: FolderOpen, children },
  ];

  it("drops a child whose module is off and keeps its sibling", () => {
    const out = visibleItems(
      parent([
        { href: "/files/a", label: "A", icon: FolderOpen, requiresModule: "docs" },
        { href: "/files/b", label: "B", icon: FolderOpen },
      ]),
      "owner",
      NO_CAPS,
      (id) => id !== "docs",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.children!.map((c) => c.href)).toEqual(["/files/b"]);
  });

  it("drops a child the caller's role excludes", () => {
    const out = visibleItems(
      parent([
        { href: "/files/admin", label: "Admin", icon: FolderOpen, roles: ["owner", "admin"] },
        { href: "/files/b", label: "B", icon: FolderOpen },
      ]),
      "family",
      NO_CAPS,
      allOn,
    );
    expect(out[0]!.children!.map((c) => c.href)).toEqual(["/files/b"]);
  });

  it("still drops every child with its parent (inheritance is preserved)", () => {
    const out = visibleItems(
      [
        {
          href: "/files",
          label: "Files",
          icon: FolderOpen,
          requiresModule: "files",
          children: [{ href: "/files/b", label: "B", icon: FolderOpen }],
        },
      ],
      "owner",
      NO_CAPS,
      (id) => id !== "files",
    );
    expect(out).toHaveLength(0);
  });

  it("leaves an item without children untouched", () => {
    const out = visibleItems(
      [{ href: "/chat", label: "Ask AI", icon: FolderOpen }],
      "guest",
      NO_CAPS,
      allOn,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.children).toBeUndefined();
  });
});

describe("gap (b) — the Integrations item is gated", () => {
  it("an owner sees Integrations", () => {
    render(<Sidebar />);
    expect(
      within(desktopAside()).getByRole("link", { name: /integrations/i }),
    ).toHaveAttribute("href", "/integrations");
  });

  it("a staff (family) member does NOT — the orchestrator gates erp.ts owner/admin", () => {
    authRef.current = { ...authRef.current, role: "family" };
    render(<Sidebar />);
    expect(document.querySelector("a[href='/integrations']")).toBeNull();
    // Its child must not be orphaned into the drawer either — the gap-(a) fix
    // is what stops the flattened child outliving its hidden parent.
    expect(document.querySelector("a[href='/integrations/eaglesoft']")).toBeNull();
  });

  it("a guest does NOT", () => {
    authRef.current = { ...authRef.current, role: "guest" };
    render(<Sidebar />);
    expect(document.querySelector("a[href='/integrations']")).toBeNull();
  });
});

describe("design §9 note (a) — a denied module leaves ALL THREE nav surfaces", () => {
  it("smart_home off removes Devices from aside, bottom tab bar, AND drawer", () => {
    modulesRef.current = { smart_home: false };
    render(<Sidebar />);
    // 1 — desktop aside
    expect(within(desktopAside()).queryByRole("link", { name: /devices/i })).toBeNull();
    // 2 — mobile bottom tab bar (the historically-missed surface: /devices is
    //     one of the four MOBILE_PRIMARY_HREFS)
    expect(within(bottomBar()).queryByRole("link", { name: /devices/i })).toBeNull();
    // 3 — More drawer
    expect(within(openDrawer()).queryByRole("link", { name: /^devices$/i })).toBeNull();
  });

  it("files off removes Files (and its whole sub-nav) from all three", () => {
    modulesRef.current = { files: false };
    pathnameRef.current = "/files";
    render(<Sidebar />);
    expect(within(desktopAside()).queryByRole("link", { name: /^files$/i })).toBeNull();
    expect(within(bottomBar()).queryByRole("link", { name: /^files$/i })).toBeNull();
    expect(within(openDrawer()).queryByRole("link", { name: /^files$/i })).toBeNull();
    // The sub-nav children must not survive their parent anywhere.
    expect(document.querySelector("a[href='/files/drives']")).toBeNull();
    expect(document.querySelector("a[href='/files/trash']")).toBeNull();
  });

  it("the always-on trio is never gateable (chat / overview / settings survive)", () => {
    // Every gateable module reports off — the always-on surfaces must remain.
    modulesRef.current = {
      files: false,
      email: false,
      calendar: false,
      projects: false,
      knowledge: false,
      cameras: false,
      network: false,
      smart_home: false,
      voice: false,
    };
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).getByRole("link", { name: /ask ai/i })).toHaveAttribute("href", "/chat");
    expect(within(aside).getByRole("link", { name: /overview/i })).toHaveAttribute("href", "/");
    expect(within(aside).getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });
});
