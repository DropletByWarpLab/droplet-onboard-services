/**
 * WARP-3076 — a Files answer the box marks `X-Droplet-Degraded` (Nextcloud
 * down, WARP-3052) must surface as FilesUnavailableError, never as an empty
 * list; an unmarked empty answer stays empty. The hooks drop SWR's stale rows
 * while unavailable so no row (or row action) lingers on screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchFiles,
  fetchTrash,
  fetchFavorites,
  fetchRecents,
  fetchSharedWithMe,
  fetchSharedByMe,
} from "./api";
import { authFetch } from "./auth";
import { FilesUnavailableError, isFilesUnavailableError } from "./files-unavailable";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

let swrState: { data: unknown; error: unknown } = { data: undefined, error: undefined };
vi.mock("swr", () => ({
  default: () => ({ ...swrState, isLoading: false, mutate: vi.fn() }),
}));

import { useTrash } from "./hooks/useTrash";
import { useRecents } from "./hooks/useRecents";
import { useFavorites } from "./hooks/useFavorites";
import { useSharedWithMe, useSharedByMe } from "./hooks/useShares";
import { useFiles } from "./hooks/useFiles";

const authFetchMock = vi.mocked(authFetch);

function res(body: unknown, degraded: boolean): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: degraded ? { "X-Droplet-Degraded": "nextcloud-unavailable" } : {},
  });
}

const fetchers: Array<[string, () => Promise<unknown[]>, unknown]> = [
  ["fetchFiles", () => fetchFiles("/"), []],
  ["fetchTrash", () => fetchTrash(), { items: [] }],
  ["fetchFavorites", () => fetchFavorites(), { items: [] }],
  ["fetchRecents", () => fetchRecents(), { items: [] }],
  ["fetchSharedWithMe", () => fetchSharedWithMe(), { shares: [] }],
  ["fetchSharedByMe", () => fetchSharedByMe(), { shares: [] }],
];

beforeEach(() => {
  authFetchMock.mockReset();
  swrState = { data: undefined, error: undefined };
});

describe.each(fetchers)("%s", (_name, call, body) => {
  it("throws FilesUnavailableError when the box marks the answer degraded", async () => {
    authFetchMock.mockResolvedValueOnce(res(body, true));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilesUnavailableError);
    expect(isFilesUnavailableError(err)).toBe(true);
  });

  it("resolves a genuinely empty answer to []", async () => {
    authFetchMock.mockResolvedValueOnce(res(body, false));
    await expect(call()).resolves.toEqual([]);
  });
});

const hooks: Array<[string, () => { items?: unknown[]; files?: unknown[] }]> = [
  ["useTrash", () => useTrash()],
  ["useRecents", () => useRecents()],
  ["useFavorites", () => useFavorites()],
  ["useSharedWithMe", () => useSharedWithMe()],
  ["useSharedByMe", () => useSharedByMe()],
  ["useFiles", () => useFiles("/")],
];

describe.each(hooks)("%s", (_name, hook) => {
  const rows = (r: { items?: unknown[]; files?: unknown[] }) => r.items ?? r.files;

  it("drops stale rows while Files are unavailable", () => {
    swrState = { data: [{ name: "stale" }], error: new FilesUnavailableError() };
    expect(rows(hook())).toEqual([]);
  });

  it("keeps the last good rows on any other error (background-poll blip)", () => {
    swrState = { data: [{ name: "kept" }], error: new Error("Failed: 500") };
    expect(rows(hook())).toEqual([{ name: "kept" }]);
  });
});
