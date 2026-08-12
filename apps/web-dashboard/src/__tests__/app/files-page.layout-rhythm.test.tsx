/**
 * WARP-1876 (part 2) — "padding is off" on My Files.
 *
 * Samantha reported three concrete things, and each gets a spec here:
 *
 *   1. the "My files" breadcrumb bar stretches full-width with sparse
 *      content — a bordered bar holding one crumb and 900px of nothing;
 *   2. a large empty region to the right of the storage card, because the
 *      volumes grid reserves three columns whatever the drive count is;
 *   3. inconsistent gaps between the search/filter controls, the storage
 *      card and the file table — the stack mixed 16px and 24px rhythm.
 *
 * (1) and (2) live in their own components and are asserted there; this
 * file pins (3), the page-level rhythm, plus the composed result.
 *
 * jsdom evaluates no Tailwind stylesheet, so the utility class is the only
 * observable — same technique the WARP-1667 layering specs use.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const EXISTING: FileEntryInfo = {
  name: "already-here.txt",
  path: "/already-here.txt",
  size: 4,
  isDirectory: false,
  mimeType: "text/plain",
  modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
} as unknown as FileEntryInfo;

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({
    files: [EXISTING],
    error: null,
    isLoading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], refresh: vi.fn() }),
}));
vi.mock("@/lib/hooks/useFileRealtime", () => ({ useFileRealtime: vi.fn() }));
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces: [], sharedAvailable: false }),
}));
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { hostname: "droplet" },
    devices: [],
    health: undefined,
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    uploadFiles: vi.fn(),
    createDirectory: vi.fn(),
    deleteFile: vi.fn(),
    getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
    getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${p}`,
    renameFile: vi.fn(),
    bulkDeleteFiles: vi.fn(),
    bulkMoveFiles: vi.fn(),
    bulkCopyFiles: vi.fn(),
    fetchShares: vi.fn().mockResolvedValue([]),
  };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    authFetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("") }),
    useAuth: () => ({
      user: { id: "u1", username: "owner", displayName: "Owner", role: "owner" },
      isLoading: false,
    }),
  };
});

import FilesPage from "@/app/files/page";

beforeEach(() => {
  cleanup();
});

/** Every `mb-<n>` utility on an element, as a set. */
function bottomMarginsOf(el: Element): string[] {
  return (el.className?.toString().match(/(?:^|\s)mb-\d+(?:\s|$)/g) ?? []).map((m) =>
    m.trim(),
  );
}

describe("Files page — one spacing rhythm (WARP-1876)", () => {
  it("stacks every content block on the same step of the scale", () => {
    render(<FilesPage />);

    const zone = document.querySelector(".page-dropzone");
    expect(zone).not.toBeNull();

    const spacings = new Set<string>();
    for (const child of Array.from(zone!.children)) {
      // The drag-over overlay is absolutely positioned — it is not part of
      // the flow rhythm.
      if (child.hasAttribute("data-dropzone-overlay")) continue;
      for (const mb of bottomMarginsOf(child)) spacings.add(mb);
    }

    // Search, spaces, breadcrumbs, volumes: one value, not a mix of 16 and
    // 24. The last block (the list + detail row) carries no bottom margin,
    // so an empty set would mean "nothing rendered" — guard that too.
    expect(spacings.size).toBeGreaterThan(0);
    expect([...spacings]).toEqual(["mb-4"]);
  });

  it("keeps the breadcrumb bar hugging its content", () => {
    render(<FilesPage />);
    // Not a full-width bordered band around a single "My files" crumb.
    expect(screen.getByLabelText("Breadcrumbs").className).toMatch(
      /(?:^|\s)w-fit(?:\s|$)/,
    );
  });
});
