/**
 * WARP-1548 — the Files-scoped layout owns the shared chrome.
 *
 * Two halves, and both matter:
 *
 *  · Source-level, following the `a11y.icon-button-labels` precedent: assert
 *    the five static sub-pages no longer carry their own `ShellPage` or the
 *    copy-pasted back-link. A render test can only prove the page renders
 *    *something*; it cannot prove the duplication is gone, and the duplication
 *    is the thing this ticket removes.
 *
 *  · Behavioural: the layout renders the header for an owned route, and passes
 *    `/files` and `/files/devices` straight through. That second case is the
 *    one worth guarding — if the layout ever wraps them, the shell renders
 *    twice and the page grows a second top bar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FILES_ROUTE_HEADERS,
  LAYOUT_OWNED,
  SELF_OWNED,
  headerForPath,
  routeOwnership,
} from "./files-routes";

// `__dirname`, the one anchoring idiom this package uses (WARP-2654) — see
// src/__tests__/helpers/test-paths.ts for why it is spelled this way here.
const here = __dirname;

function readPage(sub: string): string {
  return readFileSync(path.join(here, sub, "page.tsx"), "utf-8");
}

const STATIC_SUBVIEWS = ["drives", "favorites", "recents", "shared", "trash"];

// ── the layout's own dependencies ────────────────────────────────────────
const mockPathname = vi.fn<() => string>(() => "/files/trash");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

// ShellPage fires a health fetch and reads the box address at render.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }) };
});
vi.mock("@/lib/hooks/useBoxAddress", () => ({
  useBoxAddress: () => "droplet.local",
}));

import FilesLayout from "./layout";

describe("WARP-1548 — sub-pages no longer hand-roll their chrome", () => {
  it.each(STATIC_SUBVIEWS)("%s does not import ShellPage", (sub) => {
    expect(readPage(sub)).not.toMatch(/from "@\/components\/shell\/ShellPage"/);
  });

  it.each(STATIC_SUBVIEWS)("%s does not render a back-link", (sub) => {
    const src = readPage(sub);
    // The whole block, not just the label: the ticket's complaint is that five
    // pages spend their entire `actions` slot on a byte-identical control.
    expect(src).not.toMatch(/aria-label="Back to files"/);
    expect(src).not.toMatch(/ArrowLeft/);
  });

  it.each(STATIC_SUBVIEWS)("%s does not restate its own header strings", (sub) => {
    const src = readPage(sub);
    const header = FILES_ROUTE_HEADERS[`/files/${sub}`];
    // The sub-line is the most distinctive of the four and the one most likely
    // to drift if a page quietly reintroduces a header.
    expect(src).not.toContain(header.sub);
  });

  it("the two dynamic routes still own their chrome, deliberately", () => {
    // Guards the asymmetry documented in files-routes.ts: if someone hoists
    // these without adding the header-override machinery, their computed
    // `actions` / `sub` silently vanish rather than failing loudly.
    expect(readPage("devices")).toMatch(/from "@\/components\/shell\/ShellPage"/);
    expect(readFileSync(path.join(here, "page.tsx"), "utf-8")).toMatch(
      /from "@\/components\/shell\/ShellPage"/
    );
  });
});

describe("WARP-1548 — the route header map", () => {
  it("covers exactly the five static sub-routes", () => {
    expect(LAYOUT_OWNED.sort()).toEqual(
      STATIC_SUBVIEWS.map((s) => `/files/${s}`).sort()
    );
  });

  it("returns null for the routes that own their own chrome", () => {
    for (const route of SELF_OWNED) {
      expect(headerForPath(route)).toBeNull();
    }
  });

  it("returns null for an unknown route rather than throwing", () => {
    // A layout that throws on an unrecognised path would take the whole
    // segment down; passing children through is the safe failure.
    expect(headerForPath("/files/something-new")).toBeNull();
  });

  it("distinguishes an unknown route from a deliberately self-owned one", () => {
    // Both pass children through, so behaviour alone can't tell them apart —
    // but they mean opposite things. Collapsing them is how a sixth static
    // sub-route ends up rendering with no header and no error.
    expect(routeOwnership("/files/trash")).toBe("layout");
    expect(routeOwnership("/files")).toBe("page");
    expect(routeOwnership("/files/devices")).toBe("page");
    expect(routeOwnership("/files/something-new")).toBe("unknown");
  });

  it("keeps SELF_OWNED load-bearing, not decorative", () => {
    // Guards the finding that these constants were exported but read only by
    // this test: routeOwnership is the runtime consumer, so a route dropped
    // from SELF_OWNED changes its classification here.
    for (const route of SELF_OWNED) {
      expect(routeOwnership(route)).toBe("page");
    }
    for (const route of LAYOUT_OWNED) {
      expect(routeOwnership(route)).toBe("layout");
    }
  });
});

describe("WARP-1548 — the layout renders", () => {
  beforeEach(() => {
    mockPathname.mockReturnValue("/files/trash");
  });

  it("renders the header for an owned route", () => {
    render(
      <FilesLayout>
        <p>trash contents</p>
      </FilesLayout>
    );
    // "Trash" is deliberately in two places — the slim top-bar label and the
    // page H1 — so target the heading rather than the string.
    expect(
      screen.getByRole("heading", { name: "Trash" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(FILES_ROUTE_HEADERS["/files/trash"].sub)
    ).toBeInTheDocument();
    expect(screen.getByText("trash contents")).toBeInTheDocument();
  });

  it("renders no back-link on an owned route", () => {
    render(
      <FilesLayout>
        <p>trash contents</p>
      </FilesLayout>
    );
    expect(screen.queryByLabelText("Back to files")).toBeNull();
  });

  it.each(SELF_OWNED)("passes %s through without a second shell", (route) => {
    mockPathname.mockReturnValue(route);
    const { container } = render(
      <FilesLayout>
        <p>page owns its shell</p>
      </FilesLayout>
    );
    expect(screen.getByText("page owns its shell")).toBeInTheDocument();
    // The tell for a double-render: the layout contributing shell chrome of
    // its own on a route whose page already brings some.
    expect(container.querySelector(".droplet-shell")).toBeNull();
    expect(container.querySelector(".page-top")).toBeNull();
  });

  it("warns in dev on an unrecognised route, and still renders children", () => {
    // The whole point of naming the "unknown" case: without a ShellPage of its
    // own, a new sub-route would otherwise render headerless and silent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPathname.mockReturnValue("/files/something-new");
    render(
      <FilesLayout>
        <p>new route</p>
      </FilesLayout>
    );
    expect(screen.getByText("new route")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No header registered for \"/files/something-new\"")
    );
    warn.mockRestore();
  });

  it("does not warn on a deliberately self-owned route", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPathname.mockReturnValue("/files");
    render(
      <FilesLayout>
        <p>page owns its shell</p>
      </FilesLayout>
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
