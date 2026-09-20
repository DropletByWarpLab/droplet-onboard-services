import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNetworkViewMode, defaultMode } from "@/lib/hooks/useNetworkViewMode";

describe("defaultMode", () => {
  it("a deep-linked tab → advanced, the bare /network path → simple", () => {
    expect(defaultMode(true)).toBe("advanced");
    expect(defaultMode(false)).toBe("simple");
  });
});

describe("useNetworkViewMode", () => {
  it("opens bare /network in Simple", () => {
    const { result } = renderHook(({ d }) => useNetworkViewMode(d), {
      initialProps: { d: false },
    });
    expect(result.current.mode).toBe("simple");
  });

  it("opens a deep-linked tab (/network?tab=system) in Advanced", () => {
    const { result } = renderHook(({ d }) => useNetworkViewMode(d), {
      initialProps: { d: true },
    });
    expect(result.current.mode).toBe("advanced");
  });

  it("flips to Advanced when a deep link arrives after mount", () => {
    // A cross-tab jump (DeviceDetailPanel → Schedules) or browser back/forward
    // changes `?tab=` after first paint — the page must follow it into Advanced
    // rather than leave the tab hidden behind Simple.
    const { result, rerender } = renderHook(({ d }) => useNetworkViewMode(d), {
      initialProps: { d: false },
    });
    expect(result.current.mode).toBe("simple");
    rerender({ d: true });
    expect(result.current.mode).toBe("advanced");
  });

  it("never falls back to Simple on its own once a deep link opened Advanced", () => {
    // One-directional: the URL may take you INTO Advanced, but leaving the
    // tab behind (clicking Overview, whose href is the bare /network path)
    // must not drop a user out of the tab surface they are working in. Only
    // the Simple pill — an explicit choice — goes back.
    const { result, rerender } = renderHook(({ d }) => useNetworkViewMode(d), {
      initialProps: { d: false },
    });
    rerender({ d: true });
    expect(result.current.mode).toBe("advanced");
    rerender({ d: false });
    expect(result.current.mode).toBe("advanced");
  });

  it("does not clobber an explicit user choice on a later re-render", () => {
    const { result, rerender } = renderHook(({ d }) => useNetworkViewMode(d), {
      initialProps: { d: false },
    });
    act(() => result.current.choose("advanced")); // user opts into Advanced from the Simple view
    expect(result.current.mode).toBe("advanced");
    rerender({ d: false }); // a later re-render must not flip it back
    expect(result.current.mode).toBe("advanced");
  });
});
