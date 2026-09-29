import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFileManager } from "./useFileManager";

const KEY = "droplet.files.viewMode";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useFileManager view mode", () => {
  it("defaults to list", () => {
    const { result } = renderHook(() => useFileManager("/"));
    expect(result.current.viewMode).toBe("list");
  });

  it("persists the choice and restores it on the next mount", () => {
    const first = renderHook(() => useFileManager("/"));
    act(() => first.result.current.setViewMode("grid"));
    expect(first.result.current.viewMode).toBe("grid");
    expect(window.localStorage.getItem(KEY)).toBe("grid");
    first.unmount();

    const second = renderHook(() => useFileManager("/"));
    expect(second.result.current.viewMode).toBe("grid");
  });

  it("ignores a stored value it does not recognise", () => {
    window.localStorage.setItem(KEY, "tiles");
    const { result } = renderHook(() => useFileManager("/"));
    expect(result.current.viewMode).toBe("list");
  });

  it("still switches when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useFileManager("/"));
    expect(result.current.viewMode).toBe("list");
    act(() => result.current.setViewMode("grid"));
    expect(result.current.viewMode).toBe("grid");
  });
});
