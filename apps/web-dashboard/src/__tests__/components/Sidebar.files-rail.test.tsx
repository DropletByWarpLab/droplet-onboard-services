/**
 * WARP-1548 — the Files places rail must mount at BOTH widths.
 *
 * `docs/design/files-surface-addendum.md` §2.2 is explicit: the rail
 * supersedes `SpaceSwitcher` "at every width — desktop via the sidebar's
 * Files section, below 900px via the mobile drawer's Files section (WARP-1554
 * already renders those children under a parent caption)".
 *
 * The first cut mounted it only in the desktop `<aside>`, which is
 * `hidden lg:flex`. That left a phone user with four libraries — a practice
 * crosses three on its first day — still looking at the collapsed "Spaces ▾"
 * overflow the ticket exists to remove: the good branch shipped to the width
 * that needed it least.
 *
 * Mock setup mirrors `Sidebar.mobile.test.tsx` / `Sidebar.nesting.test.tsx`,
 * plus a `useSpaces` stub — the rail is the one piece of this nav that is
 * data, not config.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";

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
      role: "owner",
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
  useWorkspace: () => ({ workspaceType: "business" as const, isBusiness: true }),
}));

const pathnameRef = { current: "/" as string };
const searchRef = { current: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchRef.current,
}));

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));

// A practice on its first day: My Files + Workspace + three departments is
// already five, which is the branch `SpaceSwitcher` collapses into a menu.
import type { FileSpace } from "@/lib/types";
const SPACES: FileSpace[] = [
  { id: "personal", name: "My Files", root: "/", kind: "personal" },
  { id: "shared", name: "Household", root: "/Household", kind: "household" },
  { id: "dept:clinical", name: "Clinical", root: "/Clinical", kind: "department", right: "contributor" },
  { id: "dept:billing", name: "Billing", root: "/Billing", kind: "department", right: "reader" },
  { id: "dept:frontdesk", name: "Front Desk", root: "/Front Desk", kind: "department", right: "manager" },
];
const spacesRef = { current: SPACES as FileSpace[] };
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({
    spaces: spacesRef.current,
    sharedAvailable: true,
    error: undefined,
    isLoading: false,
  }),
}));

import { Sidebar } from "@/components/Sidebar";

function openDrawer() {
  const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
  act(() => {
    fireEvent.click(within(bottomNav).getByRole("button", { name: /more/i }));
  });
  return screen.getByRole("dialog");
}

describe("the rail mounts in the mobile More drawer (addendum §2.2)", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
    searchRef.current = new URLSearchParams();
    spacesRef.current = SPACES;
  });

  it("renders the Libraries group inside the drawer's Files section", () => {
    render(<Sidebar />);
    const dialog = openDrawer();
    const rail = within(dialog).getByRole("navigation", { name: "Libraries" });
    for (const label of ["My Files", "Workspace", "Billing", "Clinical", "Front Desk"]) {
      expect(within(rail).getByText(label)).toBeInTheDocument();
    }
  });

  it("puts it under the Files caption, not loose in the drawer", () => {
    render(<Sidebar />);
    const dialog = openDrawer();
    // WARP-1554's caption group: role="group" + aria-labelledby="…Files".
    const filesSection = within(dialog)
      .getAllByRole("group")
      .find((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent?.includes("Files"));
    expect(filesSection).toBeDefined();
    expect(
      within(filesSection!).getByRole("navigation", { name: "Libraries" })
    ).toBeInTheDocument();
  });

  it("offers no overflow menu — the whole point of the ticket", () => {
    render(<Sidebar />);
    const dialog = openDrawer();
    const rail = within(dialog).getByRole("navigation", { name: "Libraries" });
    expect(within(rail).queryByRole("button")).toBeNull();
    expect(within(dialog).queryByText(/^Spaces$/)).toBeNull();
  });

  it("closes the drawer when a library is tapped", async () => {
    render(<Sidebar />);
    const dialog = openDrawer();
    const rail = within(dialog).getByRole("navigation", { name: "Libraries" });
    act(() => {
      fireEvent.click(within(rail).getByRole("link", { name: /Clinical/ }));
    });
    // The <Dialog> primitive unmounts via AnimatePresence; waitFor lets the
    // exit settle (same shape as Sidebar.mobile.test.tsx). Without the
    // `onNavigate` callback the drawer would simply stay open over the page
    // the tap navigated to.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("still renders nothing on a single-space Home install (ADR-029 §5)", () => {
    spacesRef.current = [SPACES[0]];
    render(<Sidebar />);
    const dialog = openDrawer();
    expect(within(dialog).queryByRole("navigation", { name: "Libraries" })).toBeNull();
    // And the Files sub-views it sits under are untouched.
    expect(within(dialog).getByRole("link", { name: /trash/i })).toBeInTheDocument();
  });
});

describe("the desktop aside keeps its mount", () => {
  beforeEach(() => {
    pathnameRef.current = "/files";
    searchRef.current = new URLSearchParams();
    spacesRef.current = SPACES;
  });

  it("renders the Libraries group in the Files section on a /files route", () => {
    render(<Sidebar />);
    const aside = screen.getByRole("complementary", { name: /primary navigation/i });
    expect(
      within(aside).getByRole("navigation", { name: "Libraries" })
    ).toBeInTheDocument();
  });

  it("does not render it on an unrelated route", () => {
    pathnameRef.current = "/cameras";
    render(<Sidebar />);
    const aside = screen.getByRole("complementary", { name: /primary navigation/i });
    expect(
      within(aside).queryByRole("navigation", { name: "Libraries" })
    ).toBeNull();
  });
});
