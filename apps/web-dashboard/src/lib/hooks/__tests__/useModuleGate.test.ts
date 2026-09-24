/**
 * WARP-1397 — the sidebar module-gate decision (fail-open).
 * WARP-1528 — …now preferring the per-user view when the orchestrator sends it.
 * WARP-2977 P2b — …and the caller's LEVEL, which fails CLOSED for actions.
 */
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const h = vi.hoisted(() => ({
  authFetch: vi.fn(),
  user: null as null | { role?: string },
}));
vi.mock("../../auth", () => ({
  authFetch: h.authFetch,
  useAuth: () => ({ user: h.user }),
}));

import { isModuleEffective, levelAtLeast, moduleLevelFor, useModuleLevel } from "../useModuleGate";

const view = {
  modules: [
    { id: "smart_home", effective: false },
    { id: "cameras", effective: true },
    { id: "chat", effective: true },
  ],
};

describe("isModuleEffective", () => {
  it("hides a module only when it is positively not effective", () => {
    expect(isModuleEffective(view, "smart_home")).toBe(false);
    expect(isModuleEffective(view, "cameras")).toBe(true);
  });

  it("fails OPEN before the probe resolves (never hides on a blip)", () => {
    expect(isModuleEffective(undefined, "smart_home")).toBe(true);
    expect(isModuleEffective(undefined, "anything")).toBe(true);
  });

  it("shows a module the registry doesn't know (can't classify → don't hide)", () => {
    expect(isModuleEffective(view, "mystery_module")).toBe(true);
  });
});

// ── WARP-1528: the per-user layer ────────────────────────────────────
//
// `effectiveForUser` is workspace ∩ the caller's §9 grants, resolved
// server-side (ADR-032 §3). When it's present it is the ANSWER — it already
// contains the workspace intersection, so consulting `modules[].effective`
// on top would be redundant at best and wrong at worst.

const perUser = {
  modules: [
    { id: "cameras", effective: true },
    { id: "files", effective: true },
    { id: "chat", effective: true },
  ],
  effectiveForUser: [
    { moduleId: "chat", level: "act" as const },
    { moduleId: "cameras", level: "view" as const },
  ],
};

describe("isModuleEffective — effectiveForUser", () => {
  it("hides a workspace-ON module this PERSON wasn't granted", () => {
    // The box serves Files; this person's role never granted it.
    expect(isModuleEffective(perUser, "files")).toBe(false);
  });

  it("shows a module present in the person's grants", () => {
    expect(isModuleEffective(perUser, "cameras")).toBe(true);
    expect(isModuleEffective(perUser, "chat")).toBe(true);
  });

  it("hides a module absent from BOTH (workspace off ∩ not granted)", () => {
    expect(isModuleEffective(perUser, "network")).toBe(false);
  });

  it("falls back to the workspace view when the field is absent (older box)", () => {
    // An orchestrator that predates T4 sends no `effectiveForUser`; the nav
    // must keep working off the workspace payload exactly as before.
    expect(isModuleEffective(view, "smart_home")).toBe(false);
    expect(isModuleEffective(view, "cameras")).toBe(true);
  });

  it("falls back to the workspace view when the field is an EMPTY array", () => {
    // The server omits the field when it can't resolve the caller; an empty
    // array would mean "this person has nothing", which the always-on chat
    // floor makes impossible. Treat it as unresolved and fail open rather
    // than blanking every surface on a malformed payload.
    const empty = { ...view, effectiveForUser: [] };
    expect(isModuleEffective(empty, "cameras")).toBe(true);
    expect(isModuleEffective(empty, "smart_home")).toBe(false);
  });
});

// ── WARP-2977 P2b: the caller's level ─────────────────────────────────
//
// Fail-CLOSED for actions: a control shown to someone the server refuses
// turns every click into a feature-access denial — an auth/warn ActivityRow
// that the Security threat mirror then shows as a threat.

const withLevels = {
  modules: [{ id: "security", effective: true }],
  effectiveForUser: [
    { moduleId: "chat", level: "act" as const },
    { moduleId: "security", level: "act" as const },
  ],
};

describe("moduleLevelFor", () => {
  it("reads the level from the per-user set", () => {
    expect(moduleLevelFor(withLevels, "security", "family")).toBe("act");
    expect(moduleLevelFor(withLevels, "chat", "family")).toBe("act");
  });

  it("the per-user set wins even for an owner or admin (admins can be narrowed)", () => {
    expect(moduleLevelFor(withLevels, "security", "admin")).toBe("act");
    expect(moduleLevelFor(withLevels, "security", "owner")).toBe("act");
  });

  it("is `none` when the module is absent from a non-empty per-user set", () => {
    expect(moduleLevelFor(withLevels, "network", "family")).toBe("none");
    expect(moduleLevelFor(withLevels, "network", "owner")).toBe("none");
  });

  it("field absent (no local row / resolver error): owner → manage, everyone else → view", () => {
    const absent = { modules: [{ id: "security", effective: true }] };
    expect(moduleLevelFor(absent, "security", "owner")).toBe("manage");
    expect(moduleLevelFor(absent, "security", "admin")).toBe("view");
    expect(moduleLevelFor(absent, "security", "family")).toBe("view");
    expect(moduleLevelFor(absent, "security", undefined)).toBe("view");
  });

  it("an EMPTY per-user set is treated as absent", () => {
    const empty = { modules: [], effectiveForUser: [] };
    expect(moduleLevelFor(empty, "security", "owner")).toBe("manage");
    expect(moduleLevelFor(empty, "security", "admin")).toBe("view");
  });

  it("loading (or a failed probe) → view, even for an owner", () => {
    expect(moduleLevelFor(undefined, "security", "owner")).toBe("view");
    expect(moduleLevelFor(undefined, "security", "family")).toBe("view");
  });
});

describe("levelAtLeast", () => {
  it("orders none < view < act < manage", () => {
    expect(levelAtLeast("manage", "act")).toBe(true);
    expect(levelAtLeast("act", "act")).toBe(true);
    expect(levelAtLeast("view", "act")).toBe(false);
    expect(levelAtLeast("none", "view")).toBe(false);
    expect(levelAtLeast("act", "manage")).toBe(false);
  });
});

describe("useModuleLevel", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

  const respond = (body: unknown, ok = true) =>
    h.authFetch.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

  beforeEach(() => {
    h.authFetch.mockReset();
    h.user = null;
  });

  it("reads /api/modules (the nav gate's key) and returns the per-user level", async () => {
    h.user = { role: "family" };
    respond(withLevels);
    const { result } = renderHook(() => useModuleLevel("security"), { wrapper });
    await waitFor(() => expect(result.current).toBe("act"));
    expect(h.authFetch).toHaveBeenCalledWith("/api/modules");
  });

  it("is `view` while loading, then the owner fallback when the field is absent", async () => {
    h.user = { role: "owner" };
    let release: (v: unknown) => void = () => undefined;
    h.authFetch.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => useModuleLevel("security"), { wrapper });
    expect(result.current).toBe("view");
    release({ ok: true, status: 200, json: async () => ({ modules: [] }) });
    await waitFor(() => expect(result.current).toBe("manage"));
  });

  it("a failed probe leaves even an owner at view", async () => {
    h.user = { role: "owner" };
    respond({}, false);
    const { result } = renderHook(() => useModuleLevel("security"), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    // Give SWR a beat to settle the error; the level must not move off view.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe("view");
  });
});
