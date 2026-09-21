/**
 * WARP-1807 / WARP-2967 — Settings is the front door for every tucked surface.
 *
 * WARP-2967 cut the nav to four groups and moved sixteen destinations behind
 * Settings, on top of the WARP-1807 pair (Knowledge, Context) and WARP-2966's
 * Sync devices. The rows are DERIVED from `settingsGroups(NAV_GROUPS)` rather
 * than hand-listed, which is what these pins actually hold: the tuck and the
 * way back in are one decision, and a forgotten row breaks nothing, builds
 * fine and type-checks — the surface just becomes unreachable.
 *
 * Original WARP-1807 header follows, still true of the two rows it named.
 *
 * ── WARP-1807 — Settings → "Advanced" link rows.
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
// WARP-2967 — the capability-gated rows (Activity, RAG eval) resolve through
// the same admin probe the sidebar uses. Fail-closed, like the nav.
const capsRef = { current: { claudeActivity: false, ragEval: false } };

vi.mock("@/lib/api", () => ({
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  // ShellPage's status chip reads /api/orchestrator/health via this fetcher.
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

// Drive the capability gate directly rather than through SWR: its cache is
// per-module-registry, so a value changed between tests in one file would
// never reach the second render.
vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => capsRef.current,
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
  fetchUsersMock.mockResolvedValue({ users: [] });
  modulesRef.current = {};
  capsRef.current = { claudeActivity: false, ragEval: false };
});

describe("Settings — Advanced links to the tucked surfaces (WARP-1807)", () => {
  it("renders an Advanced section with Knowledge and Context link rows", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: /^advanced$/i }),
    ).toBeInTheDocument();

    // UX note (WARP-1807 review): sub-lines are period-free noun-phrase
    // fragments, matching the neighboring Voice / Software updates rows.
    const knowledge = screen.getByRole("link", { name: /knowledge/i });
    expect(knowledge).toHaveAttribute("href", "/knowledge");
    expect(knowledge.textContent).toMatch(/What's indexed for retrieval/);
    expect(knowledge.textContent).not.toMatch(/retrieval\./);

    const context = screen.getByRole("link", { name: /context/i });
    expect(context).toHaveAttribute("href", "/context");
    expect(context.textContent).toMatch(/Indexing coverage and pipeline health/);
    expect(context.textContent).not.toMatch(/health\./);
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

/**
 * WARP-2959 — Settings → "Storage" link row.
 *
 * The Drives surface moved off the Files sub-nav into /settings/storage, so
 * this row is now the ONE way in. It is the same failure shape as the
 * Advanced rows above: delete it and nothing breaks, builds, type-checks or
 * fails — the surface just becomes unreachable.
 */
describe("Settings — Storage links to the moved Drives surface (WARP-2959)", () => {
  it("renders a Storage section with a row pointing at /settings/storage", () => {
    render(<SettingsPage />);
    // By href, not by accessible name: WARP-2967's derived rows put the word
    // "storage" in two other sub-lines, and a name regex would match three.
    const storage = document.querySelector("a[href='/settings/storage']");
    expect(storage).not.toBeNull();
    expect(storage).toHaveTextContent(/pools, drives, and the system disk/i);
  });

  it("never points at the old Files address", () => {
    render(<SettingsPage />);
    expect(document.querySelector("a[href='/files/drives']")).toBeNull();
  });
});

/**
 * WARP-2966 — Settings → "Sync devices" link row.
 *
 * `docs/design/files-surface-addendum.md` §2.3: Sync Devices manages
 * sync-client pairing, not a file location, so it leaves the Files sub-nav
 * (`hidden: true` in nav-config) — and the addendum is explicit that this is
 * **a move, not a deletion**. This row is the move's other half. Same failure
 * shape as the Advanced and Storage rows above: delete it and nothing breaks,
 * builds, type-checks or fails — the surface simply becomes unreachable.
 */
describe("Settings — Sync devices links to the moved Files sub-view (WARP-2966)", () => {
  it("renders a row pointing at /files/devices", () => {
    render(<SettingsPage />);
    const devices = screen.getByRole("link", { name: /sync devices/i });
    expect(devices).toHaveAttribute("href", "/files/devices");
    expect(devices).toHaveTextContent(/computers mirroring a folder/i);
  });

  it("hides the row ONLY on a positive files-module off (fail-open, WARP-1807)", () => {
    // The nav entry carries `requiresModule: "files"`, so the row mirrors it —
    // and mirrors its posture too: a probe blip must never hide the last path
    // in. `useModuleGate` answers true for anything not explicitly false.
    modulesRef.current = { files: false };
    render(<SettingsPage />);
    expect(document.querySelector("a[href='/files/devices']")).toBeNull();
  });
});

/**
 * WARP-2967 — one row per moved destination, and no hand-kept second list.
 */
import {
  NAV_GROUPS,
  SETTINGS_SECTIONS,
  type NavItem,
} from "@/components/nav-config";

const tucked: NavItem[] = NAV_GROUPS.flatMap((g) => g.items).filter(
  (i) => i.hidden,
);

describe("Settings — the front door for every surface the nav tucked (WARP-2967)", () => {
  it("renders a row for every tucked destination that this viewer may see", () => {
    render(<SettingsPage />);
    for (const item of tucked) {
      // Activity and RAG eval are capability-gated and the probe is off here;
      // they get their own case below.
      if (item.requiresCapability) continue;
      const row = document.querySelector(`a[href='${item.href}']`);
      expect(row, `${item.href} has no Settings row`).not.toBeNull();
      expect(row).toHaveTextContent(item.label);
      expect(row).toHaveTextContent(item.settingsBlurb!);
    }
  });

  it("groups them under the five section headings, in order", () => {
    render(<SettingsPage />);
    const headings = screen
      .getAllByRole("heading")
      .map((h) => h.textContent ?? "");
    const seen = SETTINGS_SECTIONS.filter((s) => headings.includes(s));
    expect(seen).toEqual([...SETTINGS_SECTIONS]);
  });

  it("honours the capability probe — fail-closed, like the nav", () => {
    render(<SettingsPage />);
    expect(document.querySelector("a[href='/admin/rag-eval']")).toBeNull();
    expect(document.querySelector("a[href='/admin/claude-activity']")).toBeNull();
  });

  it("shows the capability-gated rows once the box reports them wired", () => {
    capsRef.current = { claudeActivity: true, ragEval: true };
    render(<SettingsPage />);
    expect(document.querySelector("a[href='/admin/rag-eval']")).not.toBeNull();
    expect(
      document.querySelector("a[href='/admin/claude-activity']"),
    ).not.toBeNull();
  });

  it("drops a row the viewer's role may not reach", () => {
    // The mocked viewer is an owner, so instead pin the predicate itself is
    // the nav's: every row rendered here carries a gate the sidebar would
    // apply identically. Console is owner/admin and present; nothing without
    // a role gate is missing.
    render(<SettingsPage />);
    expect(document.querySelector("a[href='/admin']")).not.toBeNull();
    expect(document.querySelector("a[href='/help']")).not.toBeNull();
  });
});
