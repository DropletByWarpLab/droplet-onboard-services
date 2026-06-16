/**
 * WARP-555 — useToolCatalog hook.
 *
 * Pins the contract the `/tools` page relies on: the hook fetches the
 * catalog, exposes `tools` + `domains` with empty-array defaults (so the
 * page never null-checks), and surfaces a fetch failure on `error`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { ToolCatalogResponse } from "../types";

const fetchToolCatalogMock = vi.fn();
vi.mock("../api", () => ({
  fetchToolCatalog: (...a: unknown[]) => fetchToolCatalogMock(...a),
}));

import { useToolCatalog } from "./useToolCatalog";

// Fresh SWR cache per test so a resolved value from one doesn't leak into
// the next via the shared key.
function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  fetchToolCatalogMock.mockReset();
});

describe("useToolCatalog", () => {
  it("returns empty defaults before data resolves", () => {
    fetchToolCatalogMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useToolCatalog(), { wrapper });
    expect(result.current.tools).toEqual([]);
    expect(result.current.domains).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("exposes tools and domains once loaded", async () => {
    const payload: ToolCatalogResponse = {
      tools: [
        {
          name: "list_files",
          domain: "files",
          description: "Browse your files",
          homeDescription: "Browse the files on your Droplet",
          requiresWrite: false,
          requiresConfirmation: false,
        },
      ],
      domains: ["network", "files"],
    };
    fetchToolCatalogMock.mockResolvedValue(payload);

    const { result } = renderHook(() => useToolCatalog(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tools).toHaveLength(1);
    expect(result.current.tools[0].name).toBe("list_files");
    expect(result.current.domains).toEqual(["network", "files"]);
    expect(result.current.error).toBeUndefined();
  });

  it("surfaces a fetch error", async () => {
    fetchToolCatalogMock.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useToolCatalog(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toBe("nope");
    expect(result.current.tools).toEqual([]);
  });
});
