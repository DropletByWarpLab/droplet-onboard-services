/**
 * WARP-3528 (ADR-069) — `support` rides GET /api/capabilities the way `crm`
 * does. It is new and ships `defaultEnabled: false`, so the honest answer
 * while the probe is unresolved, or when it fails, is "off": a /support that
 * guessed "on" would offer a surface the module gate then 404s. `projects` is
 * the one flag that stays open (a shipping surface a blip must not hide).
 */
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const h = vi.hoisted(() => ({ fetchAppCapabilities: vi.fn() }));
vi.mock("../../api", () => ({ fetchAppCapabilities: h.fetchAppCapabilities }));

import { APP_CAPABILITY_DEFAULTS, useAppCapabilities } from "../useAppCapabilities";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

describe("APP_CAPABILITY_DEFAULTS", () => {
  it("fails support closed with crm and contacts; only projects fails open", () => {
    expect(APP_CAPABILITY_DEFAULTS).toEqual({
      projects: true,
      crm: false,
      contacts: false,
      support: false,
    });
  });
});

describe("useAppCapabilities — support", () => {
  beforeEach(() => {
    h.fetchAppCapabilities.mockReset();
  });

  it("reads support as off until the probe answers, then honours support: true", async () => {
    let release: (v: unknown) => void = () => undefined;
    h.fetchAppCapabilities.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => useAppCapabilities(), { wrapper });
    expect(result.current.support).toBe(false);

    release({ projects: false, crm: false, contacts: false, support: true });
    await waitFor(() => expect(result.current.support).toBe(true));
    // Read on its own: a Support-only box answers with Projects and CRM off.
    expect(result.current).toEqual({
      projects: false,
      crm: false,
      contacts: false,
      support: true,
    });
  });

  it("honours support: false from the probe", async () => {
    h.fetchAppCapabilities.mockResolvedValue({
      projects: true,
      crm: true,
      contacts: false,
      support: false,
    });
    const { result } = renderHook(() => useAppCapabilities(), { wrapper });
    await waitFor(() => expect(result.current.crm).toBe(true));
    expect(result.current.support).toBe(false);
  });

  it("keeps support off when the probe fails — the closed direction", async () => {
    h.fetchAppCapabilities.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAppCapabilities(), { wrapper });
    await waitFor(() => expect(h.fetchAppCapabilities).toHaveBeenCalled());
    // Give SWR a beat to settle the error; the flags must not move.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(APP_CAPABILITY_DEFAULTS);
    expect(result.current.support).toBe(false);
  });
});
