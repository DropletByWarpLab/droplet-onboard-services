/**
 * WARP-3536 — usePresence: the drawer's heartbeat, and who else is on the item.
 *
 * One POST per beat answers both questions. It is best-effort by design: a
 * refused, rate-limited or failed beat reads as "nobody else", never as an error,
 * and never logs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";

const authFetch = vi.fn();
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import { usePresence, PRESENCE_BEAT_MS } from "./usePresence";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

function ok(viewers: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ viewers }) } as Response;
}

const beats = () => authFetch.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}`);

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockResolvedValue(ok([]));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("usePresence", () => {
  it("beats the moment the drawer opens, and returns the others on the item", async () => {
    authFetch.mockResolvedValue(ok(["u-ben", "u-cy"]));
    const { result } = renderHook(() => usePresence("w-1"), { wrapper });
    await tick(50);

    expect(beats()).toEqual(["POST /api/pm/work-items/w-1/presence"]);
    expect(result.current).toEqual(["u-ben", "u-cy"]);
  });

  it("beats every ten seconds while it is open, which keeps a 20 s entry alive through a lost beat", async () => {
    expect(PRESENCE_BEAT_MS).toBe(10_000);
    renderHook(() => usePresence("w-1"), { wrapper });
    await tick(50);
    expect(authFetch).toHaveBeenCalledTimes(1);

    await tick(PRESENCE_BEAT_MS);
    expect(authFetch).toHaveBeenCalledTimes(2);
    await tick(PRESENCE_BEAT_MS);
    expect(authFetch).toHaveBeenCalledTimes(3);
  });

  it("stops beating the moment it closes", async () => {
    const { unmount } = renderHook(() => usePresence("w-1"), { wrapper });
    await tick(50);
    unmount();
    await tick(PRESENCE_BEAT_MS * 3);
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when there is no item", async () => {
    const { result } = renderHook(() => usePresence(null), { wrapper });
    await tick(PRESENCE_BEAT_MS * 2);
    expect(authFetch).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("moves to the next item when the drawer shows another one", async () => {
    const { rerender } = renderHook(({ id }) => usePresence(id), { initialProps: { id: "w-1" }, wrapper });
    await tick(50);
    rerender({ id: "w-2" });
    await tick(50);
    expect(beats()).toEqual(["POST /api/pm/work-items/w-1/presence", "POST /api/pm/work-items/w-2/presence"]);
  });

  it("does not show the last item's viewers on the next one", async () => {
    authFetch.mockResolvedValueOnce(ok(["u-ben"]));
    const { result, rerender } = renderHook(({ id }) => usePresence(id), { initialProps: { id: "w-1" }, wrapper });
    await tick(50);
    expect(result.current).toEqual(["u-ben"]);

    let release: (r: Response) => void = () => undefined;
    authFetch.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    rerender({ id: "w-2" });
    expect(result.current).toEqual([]); // not u-ben, while w-2's first beat is in flight
    release(ok([]));
    await tick(50);
  });

  it("encodes the id it puts in the path", async () => {
    renderHook(() => usePresence("a/b c"), { wrapper });
    await tick(50);
    expect(beats()).toEqual(["POST /api/pm/work-items/a%2Fb%20c/presence"]);
  });

  describe("when a beat does not work", () => {
    let errors: ReturnType<typeof vi.spyOn>;
    let warns: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      errors.mockRestore();
      warns.mockRestore();
    });

    it.each([404, 403, 429, 500])("a %i answer reads as nobody else, and nothing is logged", async (status) => {
      authFetch.mockResolvedValue({ ok: false, status, json: () => Promise.resolve({}) } as Response);
      const { result } = renderHook(() => usePresence("w-1"), { wrapper });
      await tick(50);
      expect(result.current).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      expect(warns).not.toHaveBeenCalled();
    });

    it("a network failure reads as nobody else, nothing is logged, and the next beat still goes out", async () => {
      authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const { result } = renderHook(() => usePresence("w-1"), { wrapper });
      await tick(50);
      expect(result.current).toEqual([]);

      authFetch.mockResolvedValue(ok(["u-ben"]));
      await tick(PRESENCE_BEAT_MS);
      expect(result.current).toEqual(["u-ben"]);
      expect(errors).not.toHaveBeenCalled();
      expect(warns).not.toHaveBeenCalled();
    });

    it.each([[undefined], [null], ["u-ben"], [{ viewers: 1 }], [[1, 2]]])(
      "a malformed body (%j) reads as nobody else",
      async (viewers) => {
        authFetch.mockResolvedValue(ok(viewers));
        const { result } = renderHook(() => usePresence("w-1"), { wrapper });
        await tick(50);
        expect(result.current).toEqual([]);
      },
    );

    it("keeps only the string ids of a mixed list", async () => {
      authFetch.mockResolvedValue(ok(["u-ben", 7, null, "u-cy"]));
      const { result } = renderHook(() => usePresence("w-1"), { wrapper });
      await tick(50);
      expect(result.current).toEqual(["u-ben", "u-cy"]);
    });
  });
});
