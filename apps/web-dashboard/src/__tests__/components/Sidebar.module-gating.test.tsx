/**
 * Sidebar module-capability gating (WARP-1154/1155).
 *
 * The Projects nav entry is driven by the orchestrator's explicit module
 * gate (GET /api/modules via useModuleGate) — never by catching PM
 * request errors. Pins:
 *
 *   - `projects: true`  → the Projects entry renders (desktop sidebar).
 *   - `projects: false` → the entry is gone from BOTH the desktop sidebar and
 *     the mobile "More" drawer — the nav never advertises a surface the box
 *     won't serve.
 *   - Entries without a `requiresModule` gate are unaffected either way.
 *
 * Mock setup mirrors Sidebar.nesting.test.tsx: next/link renders real <a>
 * elements, and the auth / workspace / navigation / capabilities hooks are
 * stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "ada",
      displayName: "Ada Lovelace",
      role: "family",
    },
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
  useWorkspace: () => ({
    workspaceType: "business" as const,
    isBusiness: true,
  }),
}));

vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => "/",
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

// WARP-1397: the sidebar gates via useModuleGate (GET /api/modules), which
// supersedes the old useAppCapabilities/{projects} capability. Drive the gate
// directly — a module is "on" unless the orchestrator explicitly reports false
// (fail-open: an unlisted module stays visible).
const modulesRef = { current: { projects: true } as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (moduleId: string) => modulesRef.current[moduleId] !== false,
}));

import { Sidebar } from "@/components/Sidebar";

function desktopAside(): HTMLElement {
  const aside = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}

describe("<Sidebar> Projects module gating", () => {
  beforeEach(() => {
    modulesRef.current = { projects: true };
  });

  it("shows the Projects entry when the module capability is on", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /projects/i }),
    ).toHaveAttribute("href", "/projects");
  });

  it("hides the Projects entry when the orchestrator reports the module off", () => {
    modulesRef.current = { projects: false };
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /projects/i })).toBeNull();
    // The whole document — including the mobile nav markup — must not link
    // to a surface the box won't serve.
    expect(
      document.querySelector("a[href='/projects']"),
    ).toBeNull();
  });

  it("leaves ungated neighbors (Calendar, Knowledge) untouched when Projects is off", () => {
    modulesRef.current = { projects: false };
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /calendar/i }),
    ).toHaveAttribute("href", "/calendar");
    expect(
      within(aside).getByRole("link", { name: /knowledge/i }),
    ).toHaveAttribute("href", "/knowledge");
  });
});

/**
 * WARP-1554 — the mobile "More" drawer now keeps a bottom-tab primary's
 * children even though it drops the primary's own row. The Files sub-views
 * are the only such children today, and they must NOT outlive their parent's
 * module gate: /files carries `requiresModule: "files"`, so switching the
 * Files module off has to take the whole subtree with it (children are
 * filtered with their parent in `visibleItems`, never independently).
 */
describe("<Sidebar> Files module gating covers the sub-views (WARP-1554)", () => {
  beforeEach(() => {
    modulesRef.current = { projects: true };
  });

  function openMoreDrawer(): HTMLElement {
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    return screen.getByRole("dialog");
  }

  it("renders the Files sub-views in the drawer when the module is on", () => {
    render(<Sidebar />);
    const dialog = openMoreDrawer();
    expect(dialog.querySelector("a[href='/files/trash']")).not.toBeNull();
    expect(dialog.querySelector("a[href='/files/shared']")).not.toBeNull();
  });

  it("drops every Files sub-view when the orchestrator reports the module off", () => {
    modulesRef.current = { projects: true, files: false };
    render(<Sidebar />);
    openMoreDrawer();
    // Nothing anywhere in the document — desktop sidebar, bottom tab bar or
    // More drawer — may link into a surface the box won't serve.
    expect(document.querySelectorAll("a[href^='/files']")).toHaveLength(0);
  });
});
