/**
 * WARP-1270 (T18) — Sidebar "Company files" entry (/admin/files).
 *
 * Business-only, owner/admin only — mirrors the server-side
 * `requireRole("owner","admin")` gate on GET /api/admin/files/usage.
 * Mock setup mirrors Sidebar.module-gating.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

let authRole = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "u1", displayName: "U1", role: authRole },
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

let workspaceIsBusiness = true;
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: workspaceIsBusiness ? ("business" as const) : ("home" as const),
    setWorkspaceType: vi.fn(),
    isHome: !workspaceIsBusiness,
    isBusiness: workspaceIsBusiness,
    homeVariant: "C" as const,
  }),
  getHomeVariant: () => "C" as const,
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

vi.mock("@/lib/hooks/useAppCapabilities", () => ({
  useAppCapabilities: () => ({}),
}));

import { Sidebar } from "@/components/Sidebar";

function desktopAside(): HTMLElement {
  const aside = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}

describe("<Sidebar> Company files entry", () => {
  it("shows for an owner in Business mode", () => {
    workspaceIsBusiness = true;
    authRole = "owner";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /company files/i }),
    ).toHaveAttribute("href", "/admin/files");
  });

  it("shows for an admin in Business mode", () => {
    workspaceIsBusiness = true;
    authRole = "admin";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /company files/i }),
    ).toHaveAttribute("href", "/admin/files");
  });

  it("is absent for a non-admin role even in Business mode", () => {
    workspaceIsBusiness = true;
    authRole = "family";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /company files/i })).toBeNull();
  });

  it("is absent entirely in Home mode, regardless of role", () => {
    workspaceIsBusiness = false;
    authRole = "owner";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /company files/i })).toBeNull();
    expect(document.querySelector("a[href='/admin/files']")).toBeNull();
  });
});
