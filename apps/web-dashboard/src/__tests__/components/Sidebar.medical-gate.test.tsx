/**
 * WARP-2880 — the Practice entry follows a connected MEDICAL integration.
 *
 * `visibleItems` is pinned in nav-business-group.test.ts; this file pins the
 * Sidebar's WIRING of the flag: it must come from what the box reports on
 * GET /api/integrations, classified by connector, and never from a module or
 * admin-capability probe. Mock setup mirrors Sidebar.module-gating.test.tsx,
 * with the role raised to owner (Practice is role-hidden from family/guest
 * before this gate is ever consulted).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

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
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => () => true,
}));
vi.mock("@/lib/hooks/useTeamChat", () => ({ useTeamChatUnread: () => 0 }));

// The connected set the Sidebar reads. Only `meta.id` matters to the gate.
const connectedRef = { current: [] as Array<{ meta: { id: string } }> };
const enabledRef = { current: undefined as boolean | undefined };
vi.mock("@/lib/hooks/useIntegrations", () => ({
  useIntegrations: (enabled?: boolean) => {
    enabledRef.current = enabled;
    return { entries: [], connected: connectedRef.current, isLoading: false, error: null, refresh: vi.fn() };
  },
}));

import { Sidebar } from "@/components/Sidebar";

const practiceLink = () => document.querySelector("a[href='/practice']");

describe("<Sidebar> Practice follows a connected medical integration (WARP-2880)", () => {
  beforeEach(() => {
    connectedRef.current = [];
  });

  it("shows Practice when a practice-management system is connected", () => {
    connectedRef.current = [{ meta: { id: "eaglesoft" } }];
    render(<Sidebar />);
    expect(practiceLink()).not.toBeNull();
  });

  it("hides Practice when only a non-medical integration is connected", () => {
    connectedRef.current = [{ meta: { id: "quickbooks" } }];
    render(<Sidebar />);
    expect(practiceLink()).toBeNull();
  });

  it("hides Practice while nothing is reported connected — fail-closed, like the admin capabilities", () => {
    render(<Sidebar />);
    expect(practiceLink()).toBeNull();
    // The rest of the Business group is untouched by the gate.
    expect(document.querySelector("a[href='/business']")).not.toBeNull();
  });

  it("asks the box for owner/admin — the role the route serves", () => {
    render(<Sidebar />);
    expect(enabledRef.current).toBe(true);
  });
});
