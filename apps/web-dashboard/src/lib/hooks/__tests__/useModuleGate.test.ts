/**
 * WARP-1397 — the sidebar module-gate decision (fail-open).
 * WARP-1528 — …now preferring the per-user view when the orchestrator sends it.
 * …and the caller's LEVEL, which fails CLOSED for actions.
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

// The registry of modules that ship dark (`dark-modules.ts`) is empty in this
// build, so the ship-dark decisions below run against a synthetic one. The
// real registry is pinned in `dark-modules.test.ts`.
const dark = vi.hoisted(() => ({ ids: new Set<string>(["dark_example"]) }));
vi.mock("../../dark-modules", () => ({ ABSENT_UNLESS_LISTED: dark.ids }));

import { isModuleEffective, levelAtLeast, moduleLevelFor, useModuleGateState, useModuleLevel } from "../useModuleGate";

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

// ── a module that ships dark is ABSENT, not merely off ────────────────
//
// Such a module is not listed while unavailable (`listedWhenUnavailable:
// false`), so a switched-off box's payload has no row for it. Every other
// unlisted id reads as "a module I can't classify: show it"; for these it is
// the definition of off. The list is explicit (`dark-modules.ts`).

describe("isModuleEffective — modules that ship dark", () => {
  const darkOff = { modules: [{ id: "cameras", effective: true }] };

  it("reads a dark module as OFF when a resolved payload does not list it", () => {
    expect(isModuleEffective(darkOff, "dark_example")).toBe(false);
  });

  it("and as OFF when the per-user set does not carry it", () => {
    const perUser = { ...darkOff, effectiveForUser: [{ moduleId: "cameras", level: "view" as const }] };
    expect(isModuleEffective(perUser, "dark_example")).toBe(false);
  });

  it("reads it as ON when it is listed effective, and OFF when listed and not", () => {
    expect(isModuleEffective({ modules: [{ id: "dark_example", effective: true }] }, "dark_example")).toBe(true);
    expect(isModuleEffective({ modules: [{ id: "dark_example", effective: false }] }, "dark_example")).toBe(false);
  });

  it("fails CLOSED while the probe has not answered: nothing about it shows until the list lists it", () => {
    expect(isModuleEffective(undefined, "dark_example")).toBe(false);
  });

  it("every other module still fails OPEN while the probe has not answered", () => {
    for (const id of ["cameras", "network", "files", "chat", "mystery_module"]) {
      expect(isModuleEffective(undefined, id), id).toBe(true);
    }
  });

  it("does not turn 'unknown id → show' off for anything else", () => {
    expect(isModuleEffective(darkOff, "mystery_module")).toBe(true);
  });
});

// ── the caller's level ────────────────────────────────────────────────
//
// Fail-CLOSED for actions: a control shown to someone the server refuses
// turns every click into a feature-access denial — an auth/warn ActivityRow.

const withLevels = {
  modules: [{ id: "cameras", effective: true }],
  effectiveForUser: [
    { moduleId: "chat", level: "act" as const },
    { moduleId: "cameras", level: "act" as const },
  ],
};

describe("moduleLevelFor", () => {
  it("reads the level from the per-user set", () => {
    expect(moduleLevelFor(withLevels, "cameras", "family")).toBe("act");
    expect(moduleLevelFor(withLevels, "chat", "family")).toBe("act");
  });

  it("the per-user set wins even for an owner or admin (admins can be narrowed)", () => {
    expect(moduleLevelFor(withLevels, "cameras", "admin")).toBe("act");
    expect(moduleLevelFor(withLevels, "cameras", "owner")).toBe("act");
  });

  it("is `none` when the module is absent from a non-empty per-user set", () => {
    expect(moduleLevelFor(withLevels, "network", "family")).toBe("none");
    expect(moduleLevelFor(withLevels, "network", "owner")).toBe("none");
  });

  it("field absent (no local row / resolver error): owner → manage, everyone else → view", () => {
    const absent = { modules: [{ id: "cameras", effective: true }] };
    expect(moduleLevelFor(absent, "cameras", "owner")).toBe("manage");
    expect(moduleLevelFor(absent, "cameras", "admin")).toBe("view");
    expect(moduleLevelFor(absent, "cameras", "family")).toBe("view");
    expect(moduleLevelFor(absent, "cameras", undefined)).toBe("view");
  });

  it("an EMPTY per-user set is treated as absent", () => {
    const empty = { modules: [], effectiveForUser: [] };
    expect(moduleLevelFor(empty, "cameras", "owner")).toBe("manage");
    expect(moduleLevelFor(empty, "cameras", "admin")).toBe("view");
  });

  it("loading (or a failed probe) → view, even for an owner", () => {
    expect(moduleLevelFor(undefined, "cameras", "owner")).toBe("view");
    expect(moduleLevelFor(undefined, "cameras", "family")).toBe("view");
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
    const { result } = renderHook(() => useModuleLevel("cameras"), { wrapper });
    await waitFor(() => expect(result.current).toBe("act"));
    expect(h.authFetch).toHaveBeenCalledWith("/api/modules");
  });

  it("is `view` while loading, then the owner fallback when the field is absent", async () => {
    h.user = { role: "owner" };
    let release: (v: unknown) => void = () => undefined;
    h.authFetch.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => useModuleLevel("cameras"), { wrapper });
    expect(result.current).toBe("view");
    release({ ok: true, status: 200, json: async () => ({ modules: [] }) });
    await waitFor(() => expect(result.current).toBe("manage"));
  });

  it("a failed probe leaves even an owner at view", async () => {
    h.user = { role: "owner" };
    respond({}, false);
    const { result } = renderHook(() => useModuleLevel("cameras"), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    // Give SWR a beat to settle the error; the level must not move off view.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe("view");
  });
});

// ── the three states a page that ships dark needs to tell apart ──
//
// `useModuleGate`'s predicate answers false for BOTH "not yet answered" and
// "off" on a dark module, which is right for a nav entry and wrong for a page:
// unresolved renders nothing, off is a 404.

describe("useModuleGateState", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

  const respond = (body: unknown, ok = true) =>
    h.authFetch.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

  beforeEach(() => {
    h.authFetch.mockReset();
    h.user = null;
  });

  it("is unresolved until /api/modules answers, then on when the module is listed for the person", async () => {
    let release: (v: unknown) => void = () => undefined;
    h.authFetch.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => useModuleGateState("dark_example"), { wrapper });
    expect(result.current).toBe("unresolved");
    release({
      ok: true,
      status: 200,
      json: async () => ({
        modules: [{ id: "dark_example", effective: true }],
        effectiveForUser: [{ moduleId: "dark_example", level: "view" }],
      }),
    });
    await waitFor(() => expect(result.current).toBe("on"));
    expect(h.authFetch).toHaveBeenCalledWith("/api/modules");
  });

  it("is off when the list answered and does not list the module (absent)", async () => {
    respond({ modules: [{ id: "cameras", effective: true }], effectiveForUser: [{ moduleId: "cameras", level: "view" }] });
    const { result } = renderHook(() => useModuleGateState("dark_example"), { wrapper });
    await waitFor(() => expect(result.current).toBe("off"));
  });

  it("is off when the module is listed but switched off, and when the payload has no per-user set", async () => {
    respond({ modules: [{ id: "dark_example", effective: false }] });
    const listedOff = renderHook(() => useModuleGateState("dark_example"), { wrapper });
    await waitFor(() => expect(listedOff.result.current).toBe("off"));
    respond({ modules: [{ id: "cameras", effective: true }] });
    const noSet = renderHook(() => useModuleGateState("dark_example"), { wrapper });
    await waitFor(() => expect(noSet.result.current).toBe("off"));
  });

  it("a failed probe stays unresolved, the closed direction", async () => {
    respond({}, false);
    const { result } = renderHook(() => useModuleGateState("dark_example"), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe("unresolved");
  });
});
