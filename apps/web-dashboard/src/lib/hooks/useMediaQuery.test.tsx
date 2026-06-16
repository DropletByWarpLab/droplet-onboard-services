/**
 * WARP-837 — useMediaQuery.
 *
 * A tiny SSR-safe matchMedia hook used by EmailWorkspace to switch between the
 * desktop multi-column layout and the mobile single-pane layout. jsdom lets us
 * drive `matchMedia`, so these tests assert: it reports the initial match, it
 * updates when the media query change event fires, and it returns a stable
 * `false` when `window`/`matchMedia` is unavailable (SSR / old browsers).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useMediaQuery } from "./useMediaQuery";

type Listener = (e: MediaQueryListEvent) => void;

/**
 * Install a controllable matchMedia stub. Returns a handle that lets a test
 * flip `matches` and fire the change event the hook subscribes to.
 */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    onchange: null,
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    dispatchEvent: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("useMediaQuery", () => {
  it("reports the initial match", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query change event fires", () => {
    const handle = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    act(() => handle.set(true));
    expect(result.current).toBe(true);
  });

  it("returns false when matchMedia is unavailable", () => {
    // @ts-expect-error — simulate an environment without matchMedia.
    window.matchMedia = undefined;
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });
});
