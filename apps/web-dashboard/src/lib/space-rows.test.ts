/**
 * WARP-1548 — the shared space-row predicates.
 *
 * These moved out of `components/FileManager/SpaceSwitcher.tsx` so the
 * switcher and the places rail cannot drift apart about which rows a viewer
 * sees. The point of the module is that there is exactly ONE answer, so the
 * tests worth having are the ones that pin the answer itself — and a source
 * check that neither consumer has quietly grown a private copy again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileSpace } from "./types";
import {
  hasSpaceControl,
  isActiveState,
  isVisibleNonActive,
  rightLabel,
  spaceSwitcherVisible,
  visibleSpaces,
} from "./space-rows";

const SRC_ROOT = resolve(__dirname, "..");

const space = (id: string, state?: string): FileSpace => ({
  id,
  name: id,
  root: `/${id}`,
  kind: "department",
  state,
});

const personal: FileSpace = {
  id: "personal",
  name: "My Files",
  root: "/",
  kind: "personal",
};

describe("isActiveState", () => {
  it("treats a stateless space (personal) as active", () => {
    expect(isActiveState(personal)).toBe(true);
  });

  it("treats an explicit active state as active", () => {
    expect(isActiveState(space("a", "active"))).toBe(true);
  });

  it("treats provisioning / failed / archived as non-active", () => {
    for (const s of ["provisioning", "failed", "archiving", "archived"]) {
      expect(isActiveState(space("a", s))).toBe(false);
    }
  });
});

describe("isVisibleNonActive (WARP-1267)", () => {
  it("shows a provisioning row to anyone the server scoped it to", () => {
    expect(isVisibleNonActive(space("a", "provisioning"), false)).toBe(true);
  });

  it("shows a failed row to an owner/admin only", () => {
    expect(isVisibleNonActive(space("a", "failed"), true)).toBe(true);
    expect(isVisibleNonActive(space("a", "failed"), false)).toBe(false);
  });

  it("admits nothing else — an archived library is absent, not disabled", () => {
    expect(isVisibleNonActive(space("a", "archived"), true)).toBe(false);
  });
});

describe("visibleSpaces", () => {
  it("keeps active rows and drops a failed one from a plain member", () => {
    const spaces = [personal, space("live", "active"), space("bad", "failed")];
    expect(visibleSpaces(spaces, false).map((s) => s.id)).toEqual([
      "personal",
      "live",
    ]);
    expect(visibleSpaces(spaces, true).map((s) => s.id)).toEqual([
      "personal",
      "live",
      "bad",
    ]);
  });
});

describe("the Home-mode gate (ADR-029 §5)", () => {
  it("needs two visible spaces before any location control renders", () => {
    expect(spaceSwitcherVisible([personal], true)).toBe(false);
    expect(spaceSwitcherVisible([], true)).toBe(false);
    expect(spaceSwitcherVisible([personal, space("live", "active")])).toBe(true);
  });

  it("counts a failed row only for the viewer who may see it", () => {
    const spaces = [personal, space("bad", "failed")];
    expect(spaceSwitcherVisible(spaces, false)).toBe(false);
    expect(spaceSwitcherVisible(spaces, true)).toBe(true);
  });

  it("hasSpaceControl asks the same question of an already-filtered list", () => {
    const spaces = [personal, space("bad", "failed")];
    for (const isOwnerOrAdmin of [true, false]) {
      expect(hasSpaceControl(visibleSpaces(spaces, isOwnerOrAdmin))).toBe(
        spaceSwitcherVisible(spaces, isOwnerOrAdmin)
      );
    }
  });
});

describe("rightLabel", () => {
  it("names the three shipped rights", () => {
    expect(rightLabel("reader")).toBe("Reader");
    expect(rightLabel("contributor")).toBe("Contributor");
    expect(rightLabel("manager")).toBe("Manager");
  });

  it("falls through to the raw wire value for an unknown right", () => {
    // A chip that says `curator` is honest; a missing chip would claim the
    // viewer has no right at all.
    expect(rightLabel("curator")).toBe("curator");
  });
});

describe("one source, two consumers", () => {
  const read = (rel: string) => readFileSync(resolve(SRC_ROOT, rel), "utf8");

  it("neither the switcher nor the rail declares its own copy of the predicates", () => {
    for (const rel of [
      "components/FileManager/SpaceSwitcher.tsx",
      "components/nav/FilesLibrariesNav.tsx",
    ]) {
      const src = read(rel);
      // A local `function isActiveState` / `isVisibleNonActive` is the exact
      // divergence this module exists to prevent — the two were verbatim
      // copies of each other before WARP-1548's review.
      expect(src).not.toMatch(/function\s+isActiveState\b/);
      expect(src).not.toMatch(/function\s+isVisibleNonActive\b/);
      expect(src).not.toMatch(/RIGHT_LABEL\s*:?\s*Record</);
      expect(src).toMatch(/from "@\/lib\/space-rows"/);
    }
  });

  it("the rail does not import from the FileManager module graph", () => {
    // An always-mounted piece of global nav must not pull the Files surface's
    // components into every route's chrome.
    const rail = read("components/nav/FilesLibrariesNav.tsx");
    expect(rail).not.toMatch(/from "@\/components\/FileManager\//);
  });
});
