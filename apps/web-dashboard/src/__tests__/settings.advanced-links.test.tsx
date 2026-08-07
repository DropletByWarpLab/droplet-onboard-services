/**
 * WARP-1807 — Settings → "Advanced" link rows.
 *
 * Knowledge + Context are tucked out of the primary nav (`hidden: true` in
 * nav-config), so Settings is now the ONE way in — these rows are the other
 * half of the tuck and must not silently vanish. Pins:
 *
 *   - An "Advanced" section renders with a Knowledge row (→ /knowledge) and
 *     a Context row (→ /context), each carrying its sub-line.
 *   - The Knowledge row hides ONLY on a positive module-off — the same
 *     fail-open posture as the nav (useModuleGate): a probe blip must never
 *     hide the sole remaining path to the surface.
 *   - Context has no module gate and stays put either way.
 *
 * Mock setup mirrors settings.row-actions.test.tsx; next/link is overridden
 * locally to render real <a> elements (the global setup.ts mock returns a
 * string, so href/role queries would find nothing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

const fetchUsersMock = vi.fn();
const listProviderKeysMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  // ShellPage's status chip reads /api/orchestrator/health via this fetcher.
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "admin",
      username: "admin",
      displayName: "Admin",
      role: "owner",
    },
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: null,
    devices: [],
    health: null,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/components/ProviderKeyForm", () => ({
  ProviderKeyForm: () => null,
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

// Drive the module gate the way Sidebar.module-gating.test.tsx does: a module
// is "on" unless the orchestrator explicitly reports false (fail-open).
const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (moduleId: string) =>
    modulesRef.current[moduleId] !== false,
}));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  fetchUsersMock.mockReset();
  listProviderKeysMock.mockReset();
  fetchUsersMock.mockResolvedValue({ users: [] });
  listProviderKeysMock.mockResolvedValue([]);
  modulesRef.current = {};
});

describe("Settings — Advanced links to the tucked surfaces (WARP-1807)", () => {
  it("renders an Advanced section with Knowledge and Context link rows", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: /^advanced$/i }),
    ).toBeInTheDocument();

    const knowledge = screen.getByRole("link", { name: /knowledge/i });
    expect(knowledge).toHaveAttribute("href", "/knowledge");
    expect(knowledge.textContent).toMatch(
      /Browse what's indexed for retrieval\./,
    );

    const context = screen.getByRole("link", { name: /context/i });
    expect(context).toHaveAttribute("href", "/context");
    expect(context.textContent).toMatch(
      /Indexing coverage and pipeline health\./,
    );
  });

  it("hides the Knowledge row on a POSITIVE module-off only; Context stays", () => {
    modulesRef.current = { knowledge: false };
    render(<SettingsPage />);

    expect(screen.queryByRole("link", { name: /knowledge/i })).toBeNull();
    expect(document.querySelector("a[href='/knowledge']")).toBeNull();

    // Context carries no module gate — it must survive.
    expect(screen.getByRole("link", { name: /context/i })).toHaveAttribute(
      "href",
      "/context",
    );
  });
});
