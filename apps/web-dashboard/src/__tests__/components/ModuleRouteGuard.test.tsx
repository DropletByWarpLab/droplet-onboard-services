/**
 * WARP-1528 — nav-gate gap (c): the route-level guard.
 *
 * `useModuleGate` fails OPEN by design and that stays true — a network blip
 * must never blank a shipping surface. But hiding the nav entry was the ONLY
 * client-side consequence of a denied module, so anyone who deep-linked,
 * bookmarked, or hit Back landed on a fully rendered page shell that then
 * 404'd request by request. The server gate is the real boundary; this guard
 * makes the client stop pretending the surface is usable.
 *
 * Contract pinned here:
 *   - a positively-denied module's page content is NOT rendered;
 *   - an unresolved gate renders normally (fail-open preserved);
 *   - the always-on surfaces (/, /chat, /settings) are never blockable —
 *     design §9 note (c), self-integrity + self-lockout;
 *   - a route no module claims renders normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const pathnameRef = { current: "/" };
vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => pathnameRef.current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  };
});

// `undefined` = unresolved probe (fail open); a boolean = a positive answer.
const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (moduleId: string) => modulesRef.current[moduleId] !== false,
}));

import { ModuleRouteGuard } from "@/components/ModuleRouteGuard";

function renderAt(path: string) {
  pathnameRef.current = path;
  return render(
    <ModuleRouteGuard>
      <div data-testid="page-content">Camera streams</div>
    </ModuleRouteGuard>,
  );
}

beforeEach(() => {
  modulesRef.current = {};
  pathnameRef.current = "/";
});

describe("<ModuleRouteGuard>", () => {
  it("renders the page when the module is on", () => {
    modulesRef.current = { cameras: true };
    renderAt("/cameras");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("does NOT render the page shell when the module is positively off", () => {
    modulesRef.current = { cameras: false };
    renderAt("/cameras");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("explains itself instead of rendering a blank screen", () => {
    modulesRef.current = { cameras: false };
    renderAt("/cameras");
    // An honest, non-accusatory explanation + a way out — never a bare 404.
    // The headline names the section so the person knows what they hit.
    expect(
      screen.getByRole("heading", { name: /cameras isn.t available/i }),
    ).toBeInTheDocument();
    // Reason-free by design: the server makes a per-person denial identical to
    // a box-wide toggle, and the copy must not undo that by guessing.
    expect(screen.getByText(/switched off .* or it isn.t part of your access/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /overview/i })).toHaveAttribute("href", "/");
  });

  it("renders the section's glyph at a READABLE muted tone, not a ghost", () => {
    // UX (WARP-1528): this glyph carries the identification work a padlock
    // would otherwise do — §13 reserves Lock for "floor-blocked / off-box +
    // reason", which contradicts a deliberately reason-free refusal. Since the
    // glyph is doing that job it has to be visible: `label-tertiary` computed
    // to 1.71:1 in light mode at 24px/1.5 stroke. `label-secondary` is 5.56:1
    // light / 9.57:1 dark and still unmistakably muted against EmptyState's
    // accent-tinted invitation treatment.
    modulesRef.current = { cameras: false };
    renderAt("/cameras");
    const card = screen.getByTestId("module-route-blocked");
    const glyph = card.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("class")).toContain("text-label-secondary");
    expect(glyph!.getAttribute("class")).not.toContain("text-label-tertiary");
  });

  it("blocks a DEEP route under a denied module, not just its index", () => {
    modulesRef.current = { cameras: false };
    renderAt("/cameras/front-door");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("blocks a denied module's secondary nav href too (/events rides cameras)", () => {
    modulesRef.current = { cameras: false };
    renderAt("/events");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("fails OPEN while the gate is unresolved", () => {
    modulesRef.current = {}; // nothing positively off
    renderAt("/cameras");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("never blocks the always-on surfaces (design §9 note (c))", () => {
    // Even with every module reported off.
    modulesRef.current = {
      files: false, cameras: false, network: false, smart_home: false,
      email: false, calendar: false, projects: false, knowledge: false, voice: false,
    };
    for (const path of ["/", "/chat", "/settings", "/settings/profile"]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId("page-content")).toBeInTheDocument();
      unmount();
    }
  });

  it("renders a route no module claims", () => {
    modulesRef.current = { files: false, cameras: false };
    renderAt("/help");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("does not mistake a prefix collision for a match (/networking ≠ /network)", () => {
    modulesRef.current = { network: false };
    renderAt("/networking-guide");
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });
});
