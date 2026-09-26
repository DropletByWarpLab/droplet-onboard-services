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

/**
 * WARP-2966 — the rendered Files section, at the surface the user sees.
 *
 * `Sidebar.files-section.test.tsx` pins the nav DEFINITION; this pins what
 * reaches the DOM, because the two can disagree (a `hidden` item is in the
 * definition and on no surface, which is exactly the mechanism used here).
 */
describe("<Sidebar> Files section reads as one idea (WARP-2966)", () => {
  beforeEach(() => {
    pathnameRef.current = "/files";
    capsRef.current = { claudeActivity: false, ragEval: false };
  });

  it("reveals exactly three sub-rows — Recent, Shared, Trash", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    for (const [name, href] of [
      ["Recent", "/files/recents"],
      ["Shared", "/files/shared"],
      ["Trash", "/files/trash"],
    ] as const) {
      expect(
        within(aside).getByRole("link", { name: new RegExp(`^${name}$`, "i") }),
      ).toHaveAttribute("href", href);
    }
  });

  it("offers no row that repeats the section's own destination", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    // The Files link IS Browse. "All files" beneath it said the same word
    // twice and made the section a container of itself.
    expect(aside.querySelectorAll("a[href='/files']")).toHaveLength(1);
    expect(
      within(aside).queryByRole("link", { name: /^all files$/i }),
    ).toBeNull();
  });

  it("no longer offers Favorites or Sync devices from Files", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    expect(aside.querySelector("a[href='/files/favorites']")).toBeNull();
    expect(aside.querySelector("a[href='/files/devices']")).toBeNull();
  });

  it("keeps the section revealed on a deeper Files route", () => {
    pathnameRef.current = "/files/trash";
    render(<Sidebar />);
    const aside = desktopAside();
    expect(
      within(aside).getByRole("link", { name: /^trash$/i }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(aside).getByRole("link", { name: /^recent$/i }),
    ).toBeInTheDocument();
  });
});

/**
 * A section's pages used to be reachable only from inside the section, and
 * the collapsed rail never showed them at all. The chevron opens a section in
 * place; the rail shows an open section's pages as labelled glyphs.
 */
describe("<Sidebar> section disclosure", () => {
  beforeEach(() => {
    pathnameRef.current = "/network";
    capsRef.current = { claudeActivity: false, ragEval: false };
    localStorage.clear();
  });

  it("opens and closes a section from its chevron without navigating", () => {
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).queryByRole("link", { name: /events/i })).toBeNull();

    const toggle = within(aside).getByRole("button", { name: "Show Cameras pages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(within(aside).getByRole("link", { name: /events/i })).toHaveAttribute("href", "/events");
    fireEvent.click(within(aside).getByRole("button", { name: "Hide Cameras pages" }));
    expect(within(aside).queryByRole("link", { name: /events/i })).toBeNull();
  });

  it("keeps a closed section's links out of the tab order", () => {
    render(<Sidebar />);
    const events = desktopAside().querySelector("a[href='/events']")!;
    expect(events.closest("[inert]")).not.toBeNull();
  });

  it("shows an open section's pages in the collapsed rail, each with a name", () => {
    localStorage.setItem("droplet.sidebar.collapsed", "1");
    render(<Sidebar />);
    const aside = desktopAside();
    expect(within(aside).getByRole("link", { name: "Remote access" })).toHaveAttribute(
      "href",
      "/remote-access",
    );
    // The rail's expand control takes the header slot, ahead of every link.
    const expand = within(aside).getByRole("button", { name: "Expand sidebar" });
    expect(
      expand.compareDocumentPosition(within(aside).getAllByRole("link")[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
