import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNetworkViewMode, personaDefaultMode } from "@/lib/hooks/useNetworkViewMode";

describe("personaDefaultMode", () => {
  it("Business → advanced, Home → simple", () => {
    expect(personaDefaultMode(true)).toBe("advanced");
    expect(personaDefaultMode(false)).toBe("simple");
  });
});

describe("useNetworkViewMode", () => {
  it("defaults to simple for a Home install", () => {
    const { result } = renderHook(({ b }) => useNetworkViewMode(b), {
      initialProps: { b: false },
    });
    expect(result.current.mode).toBe("simple");
  });

  it("defaults to advanced for a Business install known at mount", () => {
    const { result } = renderHook(({ b }) => useNetworkViewMode(b), {
      initialProps: { b: true },
    });
    expect(result.current.mode).toBe("advanced");
  });

  it("re-syncs to advanced when isBusiness resolves asynchronously after mount", () => {
    // The bug: workspace type hydrates from the orchestrator after first paint,
    // so a Business install mounts with isBusiness=false and must self-correct.
    const { result, rerender } = renderHook(({ b }) => useNetworkViewMode(b), {
      initialProps: { b: false },
    });
    expect(result.current.mode).toBe("simple");
    rerender({ b: true });
    expect(result.current.mode).toBe("advanced");
  });

  it("does not clobber an explicit user choice when isBusiness later resolves", () => {
    const { result, rerender } = renderHook(({ b }) => useNetworkViewMode(b), {
      initialProps: { b: false },
    });
    act(() => result.current.choose("advanced")); // user opts into Advanced on a Home box
    expect(result.current.mode).toBe("advanced");
    rerender({ b: false }); // a later workspace re-hydrate must not flip it back
    expect(result.current.mode).toBe("advanced");
  });
});
