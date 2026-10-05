/**
 * WARP-3537 — the palette's item search: a title goes to the workspace-wide search
 * the assistant uses, a key goes to the by-key lookup that finds the item in any
 * project, and neither asks until the person has paused typing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: null }) }));

import { ITEM_SEARCH_LIMIT, useItemSearch } from "./useItemSearch";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);
const item = (id: string, key: string, name = id) => ({ id, key, name, projectId: "p1" });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const urls = () => h.authFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  h.authFetch.mockReset();
});

describe("useItemSearch", () => {
  it("asks nothing for fewer than two characters, or when disabled", async () => {
    h.authFetch.mockResolvedValue(ok({ work_items: [] }));
    const { result, rerender } = renderHook((p: { q: string; on: boolean }) => useItemSearch(p.q, p.on), {
      wrapper,
      initialProps: { q: "a", on: true },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(result.current).toEqual({ items: [], searching: false });
    rerender({ q: "invoice", on: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it("asks the workspace search for a title — once the typing has paused — and returns what it finds", async () => {
    h.authFetch.mockResolvedValue(ok({ work_items: [item("w1", "BILL-1", "Fix invoice"), item("w2", "BILL-2", "Send invoice")] }));
    const { result, rerender } = renderHook((p: { q: string }) => useItemSearch(p.q, true), { wrapper, initialProps: { q: "" } });
    rerender({ q: "invoice" });
    // Typed but not yet settled: it says it is looking, and has not asked.
    expect(result.current.searching).toBe(true);
    expect(h.authFetch).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.items.map((i) => i.key)).toEqual(["BILL-1", "BILL-2"]));
    expect(urls()).toEqual([`/api/pm/work-items?workspace=home&q=invoice&per_page=${ITEM_SEARCH_LIMIT}`]);
    await waitFor(() => expect(result.current.searching).toBe(false));
  });

  it("does not ask once per keystroke", async () => {
    h.authFetch.mockResolvedValue(ok({ work_items: [] }));
    const { rerender } = renderHook((p: { q: string }) => useItemSearch(p.q, true), { wrapper, initialProps: { q: "" } });
    rerender({ q: "in" });
    rerender({ q: "inv" });
    rerender({ q: "invo" });
    rerender({ q: "invoi" });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(urls()).toEqual([`/api/pm/work-items?workspace=home&q=invoi&per_page=${ITEM_SEARCH_LIMIT}`]);
  });

  it("looks a key up directly — in any project — and puts that hit first, once", async () => {
    h.authFetch.mockImplementation(async (url: string) =>
      String(url).includes("/by-key/")
        ? ok({ work_item: item("w9", "BILL-9", "The one") })
        : ok({ work_items: [item("w1", "BILL-1", "Other"), item("w9", "BILL-9", "The one")] }),
    );
    const { result } = renderHook(() => useItemSearch("BILL-9", true), { wrapper });
    await waitFor(() => expect(result.current.items.map((i) => i.key)).toEqual(["BILL-9", "BILL-1"]));
    expect(urls().some((u) => u === "/api/pm/work-items/by-key/BILL-9")).toBe(true);
  });

  it("does not look a title up as a key", async () => {
    h.authFetch.mockResolvedValue(ok({ work_items: [] }));
    renderHook(() => useItemSearch("fix invoice", true), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    expect(urls().some((u) => u.includes("/by-key/"))).toBe(false);
  });

  it("a failure is no items, not an error: the palette still jumps and acts", async () => {
    h.authFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useItemSearch("invoice", true), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalled());
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.items).toEqual([]);
  });

  it("a key that is no item (404) just finds nothing", async () => {
    h.authFetch.mockImplementation(async (url: string) =>
      String(url).includes("/by-key/") ? { ok: false, status: 404, json: async () => ({ error: "work_item_not_found" }) } : ok({ work_items: [] }),
    );
    const { result } = renderHook(() => useItemSearch("NOPE-1", true), { wrapper });
    await waitFor(() => expect(urls().some((u) => u.includes("/by-key/"))).toBe(true));
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.items).toEqual([]);
  });
});
