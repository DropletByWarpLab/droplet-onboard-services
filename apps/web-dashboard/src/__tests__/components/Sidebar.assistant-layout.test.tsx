/**
 * WARP-3062 — the Sidebar is the assistant layout's business side, and there
 * `/` is the Ask side's front door, so Overview is served at `/overview`.
 * Only that href moves: every other entry, and the sidebar layout itself,
 * are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

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

const pathnameRef = { current: "/overview" };
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

const layoutRef = { current: "assistant" as "sidebar" | "workspace" | "assistant" };
vi.mock("@/lib/nav-layout", () => ({
  useNavLayout: () => ({ layout: layoutRef.current, setLayout: vi.fn() }),
}));

import { Sidebar } from "@/components/Sidebar";

beforeEach(() => {
  pathnameRef.current = "/overview";
  layoutRef.current = "assistant";
});

describe("<Sidebar> under the assistant layout (WARP-3062)", () => {
  it("points Overview at /overview in the rail and lights it there", () => {
    render(<Sidebar />);
    const rail = screen.getByRole("complementary", { name: "Primary navigation" });
    const overview = within(rail).getByRole("link", { name: /overview/i });
    expect(overview).toHaveAttribute("href", "/overview");
    expect(overview).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryAllByRole("link").some((a) => a.getAttribute("href") === "/")).toBe(false);
  });

  it("keeps Overview's slot in the phone tab bar, at /overview", () => {
    render(<Sidebar />);
    const bottomNav = screen.getByRole("navigation", { name: /bottom navigation/i });
    const tabs = within(bottomNav).getAllByRole("link");
    expect(tabs).toHaveLength(4);
    expect(within(bottomNav).getByRole("link", { name: /overview/i })).toHaveAttribute(
      "href",
      "/overview",
    );
    expect(within(bottomNav).getByRole("link", { name: /ask ai/i })).toHaveAttribute("href", "/chat");
  });

  it("the sidebar layout is unchanged: Overview stays at /", () => {
    layoutRef.current = "sidebar";
    pathnameRef.current = "/";
    render(<Sidebar />);
    const rail = screen.getByRole("complementary", { name: "Primary navigation" });
    expect(within(rail).getByRole("link", { name: /overview/i })).toHaveAttribute("href", "/");
  });

  it("starts the rail below whatever bar the layout sets (0 when none)", () => {
    render(<Sidebar />);
    const rail = screen.getByRole("complementary", { name: "Primary navigation" });
    expect(rail.className).toContain("lg:top-[var(--shell-bar-h,0px)]");
    expect(rail.className).not.toContain("inset-y-0");
  });
});
