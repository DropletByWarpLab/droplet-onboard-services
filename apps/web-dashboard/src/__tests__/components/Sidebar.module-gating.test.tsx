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
import { render, within } from "@testing-library/react";

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
