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
 * WARP-1554 folded in the Files sub-views: a bottom-tab primary's children
 * must survive into the drawer even though the primary's own row does not,
 * under a non-navigating caption so nothing reads as orphaned.
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

// WARP-1341: business-only build — the provider is static, but keep the
// module mocked so this suite stays decoupled from its implementation.
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: "business" as const,
    isBusiness: true,
  }),
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

// #14/#15 — Sidebar gates the Activity + RAG-eval entries on backend
// capabilities (GET /api/admin/capabilities). A settable ref lets cases flip
// them; default OFF (hidden) so the existing drawer expectations hold.
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
import { Home as HomeIcon } from "lucide-react";

// WARP-302: fingerprint the lucide <Home> glyph by rendering it once
// at module load. The Devices tab's icon path must NOT match this
// fingerprint (it previously did, colliding with the Home tab visually
// at thumb distance on mobile).
function homeIconPath(): string {
  const div = document.createElement("div");
  // Render via React DOM by mounting the element synchronously through
  // testing-library; cheaper than booting react-dom here. Use a one-off
  // container so it doesn't leak into other tests.
  const { render: rtlRender } = require("@testing-library/react");
  const { container, unmount } = rtlRender(
    require("react").createElement(HomeIcon),
    { container: div },
  );
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  unmount();
  return d;
}

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

  it("the 5 bottom tabs are Overview, Ask AI, Files, Devices, More", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    expect(within(bottomNav).getByRole("link", { name: /overview/i })).toBeInTheDocument();
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
    expect(within(dialog).getByRole("link", { name: /projects/i })).toHaveAttribute("href", "/projects");
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

  // ── WARP-1554 ────────────────────────────────────────────────────────
  // /files owns a bottom tab, and the drawer used to drop a primary's
  // children along with the primary's own row. That left Drives, Recents,
  // Favorites, Shared, Trash and Sync Devices with NO mobile navigation path
  // whatsoever — the desktop sub-nav lives in a `hidden lg:flex` <aside>, so
  // it is no fallback. These cases pin mobile reachability so the regression
  // cannot happen silently again.
  const FILES_SUBVIEWS: Array<[string, RegExp, string]> = [
    ["Drives", /^drives$/i, "/files/drives"],
    ["Recents", /^recents$/i, "/files/recents"],
    ["Favorites", /^favorites$/i, "/files/favorites"],
    ["Shared", /^shared$/i, "/files/shared"],
    ["Trash", /^trash$/i, "/files/trash"],
    ["Sync Devices", /^sync devices$/i, "/files/devices"],
  ];

  it.each(FILES_SUBVIEWS)(
    "the More drawer makes the Files sub-view %s reachable on mobile (WARP-1554)",
    (_label, name, href) => {
      render(<Sidebar />);
      const bottomNav = screen.getByRole("navigation", {
        name: /bottom navigation/i,
      });
      fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    },
  );

  it("does not orphan the Files sub-views — they sit under a labelled, non-navigating 'Files' caption (WARP-1554)", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    // The sub-views live inside a group labelled "Files"…
    const group = within(dialog).getByRole("group", { name: /^files$/i });
    for (const [, name, href] of FILES_SUBVIEWS) {
      expect(within(group).getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }

    // …and the caption is NOT a link: /files is a bottom tab, so the drawer
    // must not offer a second, competing route to the same destination.
    expect(
      within(dialog).queryByRole("link", { name: /^files$/i }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("link", { name: /^all files$/i }),
    ).toBeNull();
    expect(dialog.querySelector("a[href='/files']")).toBeNull();
  });

  it("marks the active Files sub-view with aria-current in the drawer (WARP-1554)", () => {
    pathnameRef.current = "/files/trash";
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    expect(
      within(dialog).getByRole("link", { name: /^trash$/i }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(dialog).getByRole("link", { name: /^favorites$/i }),
    ).not.toHaveAttribute("aria-current");
  });

  it("keeps the non-primary Cameras parent as a real link with its child flattened after it (WARP-1554 regression guard)", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    // Cameras is NOT a bottom-tab primary, so it keeps its own tappable row
    // and Events still follows it — the caption treatment applies only to
    // parents displaced into the tab bar.
    const cameras = within(dialog).getByRole("link", { name: /^cameras$/i });
    const events = within(dialog).getByRole("link", { name: /^events$/i });
    expect(cameras).toHaveAttribute("href", "/cameras");
    expect(
      cameras.compareDocumentPosition(events) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    // ThemeToggle renders some control matching 'light'|'dark'|'auto' —
    // exact role is implementation-detail; assert at least one is there.
    // (WARP-298 promoted these to role=radio inside a radiogroup; the older
    // shape was role=button. Query both so this test survives either shape.)
    const themeControls = [
      ...within(dialog).queryAllByRole("radio", {
        name: /light|dark|auto|system/i,
      }),
      ...within(dialog).queryAllByRole("button", {
        name: /light|dark|auto|system/i,
      }),
    ];
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
    const overviewLink = within(bottomNav).getByRole("link", { name: /overview/i });
    expect(overviewLink).not.toHaveAttribute("aria-current");
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

  // ── UX fold-in (WARP-290) ───────────────────────────────────────────
  it("drawer renders a separator between displaced-primary group and secondary-nav group", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");

    // Pick a known displaced-primary link (Calendar) and a known
    // secondary-nav link (Cameras). The DOM order must be:
    //   Calendar → … → Cameras, with a separator <div class="h-px …">
    // somewhere between them. The desktop sidebar uses the same
    // `bg-separator` token; the drawer must mirror that mental model.
    const calendar = within(dialog).getByRole("link", { name: /calendar/i });
    const cameras = within(dialog).getByRole("link", { name: /cameras/i });

    // Sanity: Calendar comes before Cameras in DOM order.
    expect(
      calendar.compareDocumentPosition(cameras) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Find every hairline separator inside the drawer.
    const separators = dialog.querySelectorAll("div.h-px.bg-separator");
    expect(separators.length).toBeGreaterThan(0);

    // At least one separator must sit strictly between Calendar and Cameras.
    const between = Array.from(separators).some((sep) => {
      const afterCalendar =
        calendar.compareDocumentPosition(sep) & Node.DOCUMENT_POSITION_FOLLOWING;
      const beforeCameras =
        cameras.compareDocumentPosition(sep) & Node.DOCUMENT_POSITION_PRECEDING;
      return Boolean(afterCalendar && beforeCameras);
    });
    expect(between).toBe(true);
  });

  // ── WARP-302 ─────────────────────────────────────────────────────────
  // The Devices tab previously borrowed the `Home` glyph, colliding with
  // the actual Home tab's icon at thumb distance ("two homes"). Swap to
  // `Cpu` to communicate hardware/devices unambiguously. The mobile and
  // desktop branches both render the same primaryNav entry, so this test
  // pins the change on the mobile bottom tab and a sibling test below
  // pins it on the desktop sidebar.
  it("the mobile Devices tab does NOT use the lucide Home glyph (WARP-302)", () => {
    const homePath = homeIconPath();
    expect(homePath).not.toBe("");

    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    const devicesLink = within(bottomNav).getByRole("link", {
      name: /devices/i,
    });

    // Each link renders exactly one lucide <svg> for its icon. Read the
    // first path's `d` attribute as a fingerprint of the glyph — if it
    // matches the standalone <Home> render, the tab is using the Home
    // glyph and we've regressed.
    const devicesSvg = devicesLink.querySelector("svg");
    expect(devicesSvg).not.toBeNull();
    const devicesPath =
      devicesSvg!.querySelector("path")?.getAttribute("d") ?? "";
    expect(devicesPath).not.toBe("");
    expect(devicesPath).not.toBe(homePath);
  });

  it("bottom tab bar labels carry whitespace-nowrap so they never wrap on narrow viewports", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });

    // Every tab (4 links + 1 button) renders its label in a
    // <span class="type-caption-2 …">. At 320px (iPhone SE 1st gen)
    // "Ask AI" already crowds; without nowrap, a future longer label
    // (or split-screen iPad) would break the row to 2 lines and shove
    // the icon up. Pin the class so this never regresses.
    const tabLinks = within(bottomNav).getAllByRole("link");
    const moreBtn = within(bottomNav).getByRole("button", { name: /more/i });

    const labelSpans: HTMLElement[] = [];
    for (const el of [...tabLinks, moreBtn]) {
      const spans = el.querySelectorAll("span.type-caption-2");
      // Each tab/button has exactly one caption span (its label).
      expect(spans.length).toBe(1);
      labelSpans.push(spans[0] as HTMLElement);
    }

    expect(labelSpans).toHaveLength(5);
    for (const span of labelSpans) {
      expect(span.className).toMatch(/whitespace-nowrap/);
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

  it("the desktop Devices nav item does NOT use the lucide Home glyph (WARP-302)", () => {
    const homePath = homeIconPath();
    expect(homePath).not.toBe("");

    render(<Sidebar />);
    const aside = document.querySelector(
      "aside[aria-label='Primary navigation']",
    ) as HTMLElement;
    expect(aside).not.toBeNull();
    const devicesLink = within(aside).getByRole("link", { name: /devices/i });

    const devicesPath =
      devicesLink.querySelector("svg path")?.getAttribute("d") ?? "";
    expect(devicesPath).not.toBe("");
    expect(devicesPath).not.toBe(homePath);
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
    const overviewLink = within(aside).getByRole("link", { name: /overview/i });
    expect(overviewLink).not.toHaveAttribute("aria-current");
  });
});

// ── #14/#15 — capability-gated admin nav entries ────────────────────────
describe("Sidebar — admin capability nav-gating (#14/#15)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    capsRef.current = { claudeActivity: false, ragEval: false };
  });

  it("hides Activity + RAG eval when their capabilities are off", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("link", { name: /^activity$/i }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("link", { name: /rag eval/i }),
    ).toBeNull();
  });

  it("shows Activity + RAG eval once their capabilities are wired", () => {
    capsRef.current = { claudeActivity: true, ragEval: true };
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", {
      name: /bottom navigation/i,
    });
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: /^activity$/i }),
    ).toHaveAttribute("href", "/admin/claude-activity");
    expect(
      within(dialog).getByRole("link", { name: /rag eval/i }),
    ).toHaveAttribute("href", "/admin/rag-eval");
  });
});
