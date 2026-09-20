/**
 * WARP-2956 — the desktop sidebar collapses to a 64px icon rail and
 * drag-resizes between 200 and 360px.
 *
 * Pins: the collapse button's aria-expanded + accessible name, the ONE CSS
 * variable (`--sidebar-w` on <html>) both the aside and the content column
 * read, localStorage persistence, that every nav link keeps its accessible
 * name in the rail (glyph-only rows carry the label as aria-label), and the
 * resize handle's keyboard contract (←/→ nudge 8px, Home/End = min/max,
 * dblclick resets).
 *
 * Mock setup mirrors Sidebar.nesting.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const logoutMock = vi.fn(async () => {});
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "ada",
      displayName: "Ada Lovelace",
      role: "owner",
    },
    isLoading: false,
    setupRequired: false,
    login: vi.fn(),
    logout: logoutMock,
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

const pathnameRef = { current: "/" as string };
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

import { Sidebar } from "@/components/Sidebar";

const COLLAPSED_KEY = "droplet.sidebar.collapsed";
const WIDTH_KEY = "droplet.sidebar.width";

function desktopAside(): HTMLElement {
  const aside = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}

const sidebarW = () =>
  document.documentElement.style.getPropertyValue("--sidebar-w");

beforeEach(() => {
  pathnameRef.current = "/";
  localStorage.clear();
  document.documentElement.style.removeProperty("--sidebar-w");
});

describe("<Sidebar> collapse (WARP-2956)", () => {
  it("collapses to a 64px rail, persists, and every nav link keeps its accessible name", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    expect(sidebarW()).toBe("260px");

    const namesBefore = within(aside)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label") ?? a.textContent?.trim() ?? "");
    expect(namesBefore.length).toBeGreaterThan(3);

    const btn = within(aside).getByRole("button", { name: "Collapse sidebar" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(btn);

    const expandBtn = within(aside).getByRole("button", {
      name: "Expand sidebar",
    });
    expect(expandBtn).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe("1");
    expect(sidebarW()).toBe("64px");

    for (const name of namesBefore) {
      expect(within(aside).getByRole("link", { name })).toBeInTheDocument();
    }
    // Wordmark, workspace chip and group captions leave the rail.
    expect(within(aside).queryByText("Droplet")).toBeNull();
    expect(within(aside).queryByText("Business")).toBeNull();
    // The drag handle is not offered while collapsed.
    expect(
      within(aside).queryByRole("separator", { name: "Resize sidebar" }),
    ).toBeNull();
  });

  it("expanding restores the remembered width", () => {
    localStorage.setItem(WIDTH_KEY, "300");
    render(<Sidebar />);
    const aside = desktopAside();
    expect(sidebarW()).toBe("300px");

    fireEvent.click(
      within(aside).getByRole("button", { name: "Collapse sidebar" }),
    );
    expect(sidebarW()).toBe("64px");

    fireEvent.click(within(aside).getByRole("button", { name: "Expand sidebar" }));
    expect(sidebarW()).toBe("300px");
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe("0");
    expect(
      within(aside).getByRole("button", { name: "Collapse sidebar" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("boots collapsed from localStorage", () => {
    localStorage.setItem(COLLAPSED_KEY, "1");
    render(<Sidebar />);
    const aside = desktopAside();
    expect(sidebarW()).toBe("64px");
    expect(
      within(aside).getByRole("button", { name: "Expand sidebar" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("<Sidebar> resize handle (WARP-2956)", () => {
  it("is a keyboard-operable vertical separator: arrows nudge 8px, Home/End clamp, dblclick resets", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    const handle = within(aside).getByRole("separator", {
      name: "Resize sidebar",
    });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "360");
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    expect(handle).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "268");
    expect(sidebarW()).toBe("268px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("268");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "260");

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "360");
    expect(sidebarW()).toBe("360px");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    expect(sidebarW()).toBe("200px");

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    expect(sidebarW()).toBe("260px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("260");
  });

  it("clamps a stale persisted width on read", () => {
    localStorage.setItem(WIDTH_KEY, "900");
    render(<Sidebar />);
    expect(sidebarW()).toBe("360px");
  });
});
