/**
 * Sidebar nested-nav tests — "Events" under "Cameras" (Samantha QA #bugs).
 *
 * The Operations group used to render /cameras and /events as flat
 * siblings. This pins the generalized nesting: a NavItem may carry a
 * `children` array, and the desktop sidebar renders that child sub-nav
 * (mirroring the existing Files sub-nav pattern) whenever the user is
 * anywhere inside the parent section — i.e. on /cameras OR /events.
 *
 * Events must stay reachable with the correct active state, and the
 * mobile "More" drawer must keep surfacing it.
 *
 * Mock setup mirrors Sidebar.mobile.test.tsx: next/link is overridden to
 * render real <a> elements so role/aria queries work, and the auth /
 * workspace / navigation / capabilities hooks are stubbed.
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

const capsRef = {
  current: { claudeActivity: false, ragEval: false } as {
    claudeActivity: boolean;
    ragEval: boolean;
  },
};
vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => capsRef.current,
}));

import { Sidebar } from "@/components/Sidebar";

function desktopAside(): HTMLElement {
  const aside = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(aside).not.toBeNull();
  return aside;
}

describe("<Sidebar> Cameras → Events nesting (desktop)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    capsRef.current = { claudeActivity: false, ragEval: false };
  });

  it("Cameras is always present in the Operations group", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /cameras/i }),
    ).toHaveAttribute("href", "/cameras");
  });

  it("does NOT show Events as a sub-item until the user is inside the Cameras section", () => {
    // On an unrelated route, the Cameras sub-nav (and thus Events) is collapsed.
    pathnameRef.current = "/network";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /events/i })).toBeNull();
  });

  it("reveals Events nested under Cameras when on /cameras", () => {
    pathnameRef.current = "/cameras";
    render(<Sidebar />);
    const aside = desktopAside();

    const cameras = within(aside).getByRole("link", { name: /cameras/i });
    const events = within(aside).getByRole("link", { name: /events/i });
    expect(events).toHaveAttribute("href", "/events");

    // Events renders AFTER Cameras in DOM order — it is nested beneath it.
    expect(
      cameras.compareDocumentPosition(events) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reveals Events nested under Cameras when on /events", () => {
    pathnameRef.current = "/events";
    render(<Sidebar />);
    const aside = desktopAside();

    expect(
      within(aside).getByRole("link", { name: /cameras/i }),
    ).toHaveAttribute("href", "/cameras");
    expect(within(aside).getByRole("link", { name: /events/i })).toHaveAttribute(
      "href",
      "/events",
    );
  });

  it("marks Events active (aria-current=page) when on /events, not Cameras", () => {
    pathnameRef.current = "/events";
    render(<Sidebar />);
    const aside = desktopAside();

    const events = within(aside).getByRole("link", { name: /events/i });
    const cameras = within(aside).getByRole("link", { name: /cameras/i });

    expect(events).toHaveAttribute("aria-current", "page");
    // The Cameras parent reads as in-section but the Events leaf owns the
    // current-page state, so /cameras must NOT also claim aria-current.
    expect(cameras).not.toHaveAttribute("aria-current");
  });

  it("marks the Cameras index sub-item active (aria-current=page) when on /cameras, not Events", () => {
    pathnameRef.current = "/cameras";
    render(<Sidebar />);
    const aside = desktopAside();

    const events = within(aside).getByRole("link", { name: /events/i });
    expect(events).not.toHaveAttribute("aria-current");
  });
});

describe("<Sidebar> Cameras → Events nesting (mobile drawer)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    capsRef.current = { claudeActivity: false, ragEval: false };
  });

  it("keeps Events reachable in the More drawer with the correct href", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByRole("link", { name: /cameras/i })).toHaveAttribute(
      "href",
      "/cameras",
    );
    expect(within(dialog).getByRole("link", { name: /events/i })).toHaveAttribute(
      "href",
      "/events",
    );
  });

  it("marks Events active in the drawer when on /events", () => {
    pathnameRef.current = "/events";
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByRole("link", { name: /events/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
