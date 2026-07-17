/**
 * WARP-1270 (T18) — Sidebar "Company files" entry (/admin/files).
 *
 * Owner/admin only — mirrors the server-side
 * `requireRole("owner","admin")` gate on GET /api/admin/files/usage.
 * (WARP-1341: the build is business-only, so there is no workspace gate.)
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
  it("shows for an owner", () => {
    authRole = "owner";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /company files/i }),
    ).toHaveAttribute("href", "/admin/files");
  });

  it("shows for an admin", () => {
    authRole = "admin";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /company files/i }),
    ).toHaveAttribute("href", "/admin/files");
  });

  it("is absent for a non-admin role", () => {
    authRole = "family";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /company files/i })).toBeNull();
    expect(document.querySelector("a[href='/admin/files']")).toBeNull();
  });
});
