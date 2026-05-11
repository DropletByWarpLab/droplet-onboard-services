/**
 * WARP-290 — Sidebar mobile tests.
 *
 * Pins the mobile branch (`<lg`) to a 5-item bottom tab bar (Home,
 * Ask AI, Files, Devices, More) and the "More" trigger to a side-panel
 * dialog built on the WARP-289 `<Dialog>` primitive. The dialog hosts
 * every nav destination NOT in the bottom 5 plus the theme toggle and
 * sign-out — so on phone/tablet Settings / Users / Cameras / Network /
 * Events / Remote Access / Knowledge / Context / Calendar are all
 * reachable through a single tap target.
 *
 * The desktop branch (`lg:`) renders the same component in JSDOM but
 * remains unchanged; the tests here scope every query to the mobile
 * `<nav aria-label="Bottom navigation">` landmark so they never accidentally
 * pick up desktop sidebar links of the same name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

// Local override: the global setup.ts mock for next/link returns a string
// (kept lightweight for snapshot-style tests). Sidebar renders <Link> nodes
// directly — we need real <a> elements so role / aria queries work.
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

// useAuth/useTheme require context providers we don't want to wire up
// just to test navigation a11y. Mock both.
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

// Pathname for active-tab assertions. Tests can override per-case via
// the `usePathname` mock setter below.
const pathnameRef = { current: "/" as string };
vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => pathnameRef.current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  };
});

// framer-motion: skip transitions so the dialog renders synchronously.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

import { Sidebar } from "@/components/Sidebar";

function setMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

describe("<Sidebar> mobile branch (WARP-290)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    setMatchMedia(false); // simulate < lg
    logoutMock.mockClear();
  });

  it("renders exactly 5 items in the bottom tab bar including a 'More' trigger", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    // Direct child anchors/buttons — the tab strip.
    const tabs = within(bottomNav).getAllByRole("link");
    const moreButton = within(bottomNav).queryByRole("button", { name: /more/i });
    // 4 links + 1 button (the More trigger is a button, not a link).
    expect(tabs).toHaveLength(4);
    expect(moreButton).not.toBeNull();
    // Total tab targets == 5 by iOS convention.
    expect(tabs.length + 1).toBe(5);
  });

  it("the 5 bottom tabs are Home, Ask AI, Files, Devices, More", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    expect(within(bottomNav).getByRole("link", { name: /home/i })).toBeInTheDocument();
    expect(within(bottomNav).getByRole("link", { name: /ask ai/i })).toBeInTheDocument();
    expect(within(bottomNav).getByRole("link", { name: /files/i })).toBeInTheDocument();
    expect(within(bottomNav).getByRole("link", { name: /devices/i })).toBeInTheDocument();
    expect(within(bottomNav).getByRole("button", { name: /more/i })).toBeInTheDocument();
  });

  it("opens a dialog with role='dialog', aria-modal, aria-labelledby when More is tapped", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    const moreBtn = within(bottomNav).getByRole("button", { name: /more/i });
    act(() => {
      fireEvent.click(moreBtn);
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    // The labelling element exists and has non-empty text content.
    const heading = document.getElementById(labelId!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent?.trim()).toBeTruthy();
  });

  it("the More drawer surfaces every displaced primary + every secondary nav destination", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    // Displaced primary items (not in the 5-tab bar):
    expect(within(dialog).getByRole("link", { name: /calendar/i })).toHaveAttribute("href", "/calendar");
    expect(within(dialog).getByRole("link", { name: /knowledge/i })).toHaveAttribute("href", "/knowledge");
    expect(within(dialog).getByRole("link", { name: /context/i })).toHaveAttribute("href", "/context");

    // Every secondary nav destination:
    expect(within(dialog).getByRole("link", { name: /cameras/i })).toHaveAttribute("href", "/cameras");
    expect(within(dialog).getByRole("link", { name: /events/i })).toHaveAttribute("href", "/events");
    expect(within(dialog).getByRole("link", { name: /network/i })).toHaveAttribute("href", "/network");
    expect(within(dialog).getByRole("link", { name: /remote access/i })).toHaveAttribute("href", "/remote-access");
    expect(within(dialog).getByRole("link", { name: /users/i })).toHaveAttribute("href", "/users");
    expect(within(dialog).getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });

  it("the More drawer includes the theme toggle and a sign-out control", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");
    // Theme toggle exposes its three options as radios/buttons by name.
    // We don't assume the exact role choice — just that at least one
    // matchable control for each appearance mode is inside the drawer.
    expect(within(dialog).getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    // ThemeToggle renders some control matching 'light'|'dark'|'system' —
    // exact role is implementation-detail; assert at least one is there.
    const themeControls = within(dialog).queryAllByRole("button", {
      name: /light|dark|system/i,
    });
    expect(themeControls.length).toBeGreaterThan(0);
  });

  it("dismisses the drawer via Escape (WARP-289 primitive behaviour)", async () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    // The <Dialog> primitive unmounts via AnimatePresence; waitFor lets
    // the exit phase finish before we assert.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("sets aria-current='page' on the active mobile bottom tab", () => {
    pathnameRef.current = "/files";
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    const filesLink = within(bottomNav).getByRole("link", { name: /files/i });
    expect(filesLink).toHaveAttribute("aria-current", "page");
    // Non-active siblings must NOT carry aria-current.
    const homeLink = within(bottomNav).getByRole("link", { name: /home/i });
    expect(homeLink).not.toHaveAttribute("aria-current");
  });

  it("the mobile <nav> exposes an aria-label landmark", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    expect(bottomNav).toHaveAttribute("aria-label", "Bottom navigation");
  });

  it("each drawer item is a ≥44px tap target (min-h-[44px] or equivalent)", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");
    const drawerLinks = within(dialog).getAllByRole("link");
    expect(drawerLinks.length).toBeGreaterThan(0);
    for (const link of drawerLinks) {
      const cls = link.className;
      // Accept any min-h utility >= 44 (token min-h-[44px], min-h-11 == 44px).
      expect(cls).toMatch(/min-h-\[44px\]|min-h-11|h-11|h-\[44px\]|h-12|min-h-12/);
    }
  });
});

describe("<Sidebar> desktop branch a11y (WARP-290)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    setMatchMedia(true); // >= lg
  });

  it("desktop <aside> exposes an aria-label landmark", () => {
    render(<Sidebar />);
    // Desktop primary nav is rendered in an <aside> with role implicit.
    // We assert by aria-label.
    const aside = document.querySelector("aside[aria-label='Primary navigation']");
    expect(aside).not.toBeNull();
  });

  it("sets aria-current='page' on the active desktop nav item", () => {
    pathnameRef.current = "/settings";
    render(<Sidebar />);
    const aside = document.querySelector(
      "aside[aria-label='Primary navigation']",
    ) as HTMLElement;
    expect(aside).not.toBeNull();
    const settingsLink = within(aside).getByRole("link", { name: /settings/i });
    expect(settingsLink).toHaveAttribute("aria-current", "page");
    const homeLink = within(aside).getByRole("link", { name: /home/i });
    expect(homeLink).not.toHaveAttribute("aria-current");
  });
});
