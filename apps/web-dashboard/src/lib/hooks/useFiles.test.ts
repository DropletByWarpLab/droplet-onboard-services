/**
 * WARP-1623 — the directory-listing SWR key must carry the space.
 *
 * The key branched two ways (`shared` vs everything else), so a department
 * listing and the personal listing at the same path collapsed onto ONE cache
 * entry: `/api/files?path=/Q1`. Whichever space fetched first won, and the
 * other rendered its neighbour's contents. The server-side twin of this bug is
 * WARP-1610 (the orchestrator's files:list cache key had no space dimension).
 *
 * `useSWR` is mocked, which leaves `useFiles` a pure function of its arguments —
 * so the key is asserted directly, with no renderer involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const keys: unknown[] = [];
vi.mock("swr", () => ({
  default: (key: unknown) => {
    keys.push(key);
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock("../api", () => ({ fetchFiles: vi.fn() }));

import { useFiles } from "./useFiles";

const DEPT = "dept:2f1c9a84-77d3-4a11-9a2e-6b0f5c1d8e42";

beforeEach(() => {
  keys.length = 0;
});

describe("useFiles — SWR key (WARP-1623)", () => {
  it("keys a department listing separately from the personal one at the same path", () => {
    useFiles("/Q1", DEPT);
    useFiles("/Q1", "personal");
    expect(keys[0]).not.toEqual(keys[1]);
  });

  it("names the space in the department key", () => {
    useFiles("/Q1", DEPT);
    expect(String(keys[0])).toContain(DEPT);
  });

  it("keeps two different departments on separate keys", () => {
    useFiles("/", DEPT);
    useFiles("/", "dept:9c7e1b05-4a62-4c3f-8d10-2e5a7f9b3c61");
    expect(keys[0]).not.toEqual(keys[1]);
  });

  it("leaves the personal key byte-identical to the pre-spaces shape", () => {
    useFiles("/Documents");
    expect(keys[0]).toBe("/api/files?path=/Documents");
  });

  it("leaves the shared key unchanged", () => {
    useFiles("/Trips", "shared");
    expect(keys[0]).toBe("/api/files?space=shared&path=/Trips");
  });
});
