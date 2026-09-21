/**
 * WARP-2967 — the contextual Settings panel.
 *
 * Practice 2 of the sidebar-UX reference
 * (`shared_brain/research/design/sidebar-ux-reference`, rule 4): when the user
 * enters a section with its own deep structure — Settings, always — the
 * sidebar swaps to a focused menu for that section, visually distinct, and
 * ALWAYS carries "Back to main menu" at the top.
 *
 * Sixteen destinations now live behind Settings. Rendering them as the main
 * tree's fifth group would put the thirteen Admin rows back; rendering them
 * only on the Settings page would leave the sidebar pointing at nothing you
 * are near the moment you arrive on /admin/audit.
 *
 * Mock setup mirrors Sidebar.nesting.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada Lovelace", role: "owner" },
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
  useCapabilities: () => ({ claudeActivity: true, ragEval: true }),
}));

import { Sidebar } from "@/components/Sidebar";

function aside(): HTMLElement {
  const el = document.querySelector(
    "aside[aria-label='Primary navigation']",
  ) as HTMLElement;
  expect(el).not.toBeNull();
  return el;
}

beforeEach(() => {
  pathnameRef.current = "/";
  localStorage.clear();
});

describe("the main tree is four groups and a Settings row (WARP-2967)", () => {
  it("captions exactly Work, Business and Systems — Admin's lone row needs none", () => {
    render(<Sidebar />);
    const nav = within(aside()).getByRole("navigation", { name: /sections/i });
    for (const caption of ["Work", "Business", "Systems"])
      expect(within(nav).getByText(caption)).toBeInTheDocument();
    // A caption over one row names nothing the row does not already say.
    expect(within(nav).queryByText("Admin")).toBeNull();
  });

  it("offers Settings, and none of the surfaces tucked behind it", () => {
    render(<Sidebar />);
    const a = aside();
    expect(within(a).getByRole("link", { name: /^settings$/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    for (const href of ["/admin", "/users", "/tools", "/models", "/health", "/help", "/trust", "/downloads", "/integrations", "/routines", "/workshop", "/admin/audit"])
      expect(a.querySelector(`a[href='${href}']`), href).toBeNull();
  });
});

describe("the sidebar swaps to the Settings panel inside Settings (WARP-2967)", () => {
  it.each(["/settings", "/settings/storage", "/admin/audit", "/tools"])(
    "renders the panel on %s, not the main tree",
    (pathname) => {
      pathnameRef.current = pathname;
      render(<Sidebar />);
      const a = aside();
      expect(
        within(a).getByRole("navigation", { name: /settings/i }),
      ).toBeInTheDocument();
      // The main tree's working destinations are not also on screen — that
      // would be two navs, which is the pile this replaces.
      expect(a.querySelector("a[href='/cameras']")).toBeNull();
      expect(a.querySelector("a[href='/calendar']")).toBeNull();
    },
  );

  it("groups the rows and carries every tucked destination", () => {
    pathnameRef.current = "/settings";
    render(<Sidebar />);
    const panel = within(aside()).getByRole("navigation", { name: /settings/i });
    for (const caption of ["Account", "Workspace", "Automation", "System", "Advanced"])
      expect(within(panel).getByText(caption)).toBeInTheDocument();
    for (const href of ["/users", "/admin", "/tools", "/models", "/health", "/help", "/trust", "/downloads", "/integrations", "/integrations/credentials", "/routines", "/workshop", "/admin/audit", "/admin/prompt", "/admin/files", "/knowledge", "/context", "/files/devices", "/admin/claude-activity", "/admin/rag-eval"])
      expect(panel.querySelector(`a[href='${href}']`), href).not.toBeNull();
  });

  it("marks the row you are on", () => {
    pathnameRef.current = "/admin/audit";
    render(<Sidebar />);
    const panel = within(aside()).getByRole("navigation", { name: /settings/i });
    expect(
      within(panel).getByRole("link", { name: /^audit log$/i }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("leads with Back to main menu, and that returns the main tree", () => {
    pathnameRef.current = "/settings";
    render(<Sidebar />);
    const back = within(aside()).getByRole("button", {
      name: /back to main menu/i,
    });
    // First thing in the panel — the reference is explicit that it sits at the
    // top of the contextual panel, not beside the section captions.
    const panel = within(aside()).getByRole("navigation", { name: /settings/i });
    expect(
      back.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => {
      fireEvent.click(back);
    });
    // The working destinations are back, WITHOUT leaving the settings page —
    // you came here to go somewhere else, not to lose your place.
    expect(aside().querySelector("a[href='/cameras']")).not.toBeNull();
    expect(
      within(aside()).queryByRole("navigation", { name: /settings/i }),
    ).toBeNull();
  });

  it("does not swap on a working route", () => {
    pathnameRef.current = "/files/trash";
    render(<Sidebar />);
    expect(
      within(aside()).queryByRole("navigation", { name: /settings/i }),
    ).toBeNull();
    expect(aside().querySelector("a[href='/cameras']")).not.toBeNull();
  });
});

describe("the Settings panel in the 64px rail (WARP-2956 × WARP-2967)", () => {
  beforeEach(() => {
    localStorage.setItem("droplet.sidebar.collapsed", "1");
  });

  it("renders glyphs only, with the accessible names intact", () => {
    pathnameRef.current = "/settings";
    render(<Sidebar />);
    const panel = within(aside()).getByRole("navigation", { name: /settings/i });
    // Captions are chrome the rail has no room for — the main tree drops its
    // own the same way.
    expect(within(panel).queryByText("Advanced")).toBeNull();
    // …but every row keeps a name, so the rail is navigable by screen reader
    // and by tooltip.
    const audit = within(panel).getByRole("link", { name: /^audit log$/i });
    expect(audit).toHaveAttribute("href", "/admin/audit");
    expect(audit).toHaveAttribute("title", "Audit log");
    expect(audit.textContent).toBe("");
    // The way out survives collapse.
    expect(
      within(aside()).getByRole("button", { name: /back to main menu/i }),
    ).toBeInTheDocument();
  });
});
