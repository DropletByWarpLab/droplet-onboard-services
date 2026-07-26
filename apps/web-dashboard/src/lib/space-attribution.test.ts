/**
 * WARP-1549 — the shared library-attribution resolver.
 *
 * Every sub-view (Favorites, Recents, Trash, Shared) resolves rows through
 * this one module, so its edge cases are pinned here rather than four times
 * over in page tests: longest-prefix matching, the mount-name collisions the
 * ticket calls out, and — most importantly — the cases where the honest answer
 * is "we don't know" rather than "My Files".
 */
import { describe, it, expect } from "vitest";
import {
  buildFilesUrl,
  filesUrlForEntry,
  isPathInSpaceRoot,
  libraryLabelForPath,
  resolveFileSpace,
  spaceDisplayName,
  spaceRelativePath,
} from "./space-attribution";
import type { FileSpace } from "./types";

const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const HOUSEHOLD: FileSpace = {
  id: "shared",
  name: "Household",
  spaceRef: "dept:household-uuid",
  root: "/Household",
  kind: "household",
  state: "active",
};
const FINANCE: FileSpace = {
  id: "dept:finance",
  name: "Finance",
  root: "/Finance",
  kind: "department",
  state: "active",
  right: "contributor",
  isMember: true,
};
/** A team: mounted flat as "<Parent> — <Team>". */
const PLATFORM: FileSpace = {
  id: "dept:eng-platform",
  name: "Platform",
  parentName: "Engineering",
  root: "/Engineering — Platform",
  kind: "team",
  state: "active",
  right: "reader",
  isMember: true,
};

const ALL = [PERSONAL, HOUSEHOLD, FINANCE, PLATFORM];

describe("isPathInSpaceRoot — segment boundaries, not startsWith", () => {
  it("matches the root itself and anything under it", () => {
    expect(isPathInSpaceRoot("/Finance", "/Finance")).toBe(true);
    expect(isPathInSpaceRoot("/Finance/Q1/plan.xlsx", "/Finance")).toBe(true);
  });

  it("does NOT match a sibling that merely shares a name prefix", () => {
    expect(isPathInSpaceRoot("/Financeable/x", "/Finance")).toBe(false);
    expect(isPathInSpaceRoot("/Household Archive/2019/x", "/Household")).toBe(false);
  });

  it("treats the personal root as containing everything", () => {
    expect(isPathInSpaceRoot("/anything/at/all", "/")).toBe(true);
  });

  it("tolerates a trailing slash on the root", () => {
    expect(isPathInSpaceRoot("/Finance/Q1", "/Finance/")).toBe(true);
  });
});

describe("spaceRelativePath", () => {
  it("strips exactly one leading mount prefix", () => {
    expect(spaceRelativePath("/Finance/Q1/plan.xlsx", "/Finance")).toBe("/Q1/plan.xlsx");
    expect(spaceRelativePath("/Finance", "/Finance")).toBe("/");
  });

  it("keeps a child literally named like its own mount", () => {
    expect(spaceRelativePath("/Finance/Finance/x", "/Finance")).toBe("/Finance/x");
  });

  it("passes through a path outside the root", () => {
    expect(spaceRelativePath("/Docs/x", "/Finance")).toBe("/Docs/x");
  });
});

describe("resolveFileSpace — longest prefix wins", () => {
  it("attributes a department file to its department", () => {
    const result = resolveFileSpace("/Finance/Q1/plan.xlsx", ALL);
    expect(result.confidence).toBe("matched");
    expect(result.space?.id).toBe("dept:finance");
    expect(result.spacePath).toBe("/Q1/plan.xlsx");
  });

  it("attributes a Household file to the shared space", () => {
    const result = resolveFileSpace("/Household/Trips/italy.pdf", ALL);
    expect(result.space?.id).toBe("shared");
    expect(result.spacePath).toBe("/Trips/italy.pdf");
  });

  it("picks the LONGEST matching root, not the first", () => {
    // A sub-library mounted inside another library's namespace: a naive
    // first-match (or a shortest-first scan) would hand the file to the parent.
    const archive: FileSpace = {
      id: "dept:finance-archive",
      name: "Finance Archive",
      root: "/Finance/Archive",
      kind: "department",
      state: "active",
    };
    const result = resolveFileSpace("/Finance/Archive/2019/ledger.csv", [
      PERSONAL,
      FINANCE,
      archive,
    ]);
    expect(result.space?.id).toBe("dept:finance-archive");
    expect(result.spacePath).toBe("/2019/ledger.csv");
  });

  it("does not let '/Household' claim '/Household Archive' (the ticket's collision)", () => {
    const result = resolveFileSpace("/Household Archive/2019/receipt.pdf", ALL);
    expect(result.confidence).toBe("assumed-personal");
    expect(result.space).toBeNull();
  });

  it("resolves a team mount, em dash and all", () => {
    const result = resolveFileSpace("/Engineering — Platform/specs/api.md", ALL);
    expect(result.space?.id).toBe("dept:eng-platform");
    expect(result.spacePath).toBe("/specs/api.md");
  });

  it("resolves a team whose OWN name contains an em dash", () => {
    // Roots are compared whole — the separator is never parsed — so an em dash
    // inside either half is a non-event.
    const oddTeam: FileSpace = {
      id: "dept:ops-q1",
      name: "Q1 — Planning",
      parentName: "Ops",
      root: "/Ops — Q1 — Planning",
      kind: "team",
      state: "active",
    };
    const result = resolveFileSpace("/Ops — Q1 — Planning/roadmap.md", [PERSONAL, oddTeam]);
    expect(result.space?.id).toBe("dept:ops-q1");
    expect(result.spacePath).toBe("/roadmap.md");
    expect(spaceDisplayName(oddTeam)).toBe("Ops — Q1 — Planning");
  });

  it("falls back to the personal space for a plain home file", () => {
    const result = resolveFileSpace("/Documents/budget.xlsx", ALL);
    expect(result.confidence).toBe("assumed-personal");
    expect(result.space).toBeNull();
    expect(result.spaceId).toBe("personal");
    expect(result.spacePath).toBe("/Documents/budget.xlsx");
  });

  it("attributes the library root itself", () => {
    const result = resolveFileSpace("/Finance", ALL);
    expect(result.space?.id).toBe("dept:finance");
    expect(result.spacePath).toBe("/");
  });
});

describe("resolveFileSpace — degrading honestly", () => {
  it("reports UNKNOWN, not personal, while the space list is unavailable", () => {
    // Still loading, or /api/files/spaces failed. Claiming "My Files" here
    // would mislabel every library row on the page.
    const result = resolveFileSpace("/Finance/Q1/plan.xlsx", []);
    expect(result.confidence).toBe("unknown");
    expect(result.space).toBeNull();
  });

  it("prints no label at all when a library is no longer visible to the caller", () => {
    // Membership revoked between the row being fetched and rendered: the
    // Finance library is gone from the space list, so its path stops matching.
    const afterRevocation = [PERSONAL, HOUSEHOLD];
    expect(libraryLabelForPath("/Finance/Q1/plan.xlsx", afterRevocation)).toBeNull();
    // Specifically: it must NOT be re-badged as the personal space.
    expect(libraryLabelForPath("/Finance/Q1/plan.xlsx", afterRevocation)).not.toBe("My Files");
  });

  it("prints no label while the space list is unavailable", () => {
    expect(libraryLabelForPath("/Finance/Q1/plan.xlsx", [])).toBeNull();
  });

  it("still routes somewhere safe when it cannot attribute", () => {
    // Personal space + the full home-relative path: the same fail-safe the
    // Files page applies to an unknown ?space= id. The groupfolder mount lives
    // inside the home, so this is also the path that lists if access remains.
    const url = filesUrlForEntry(
      { path: "/Finance/Q1/plan.xlsx", isDirectory: false },
      [PERSONAL, HOUSEHOLD]
    );
    expect(url).toBe("/files?path=%2FFinance%2FQ1");
  });
});

describe("resolveFileSpace — same-display-name team ambiguity", () => {
  // The team → parent join is by DISPLAY NAME, not id, so two departments that
  // share a name, each with a same-named team, mint one identical mount name.
  const teamA: FileSpace = {
    id: "dept:team-a",
    name: "Platform",
    parentName: "Engineering",
    root: "/Engineering — Platform",
    kind: "team",
    state: "active",
  };
  const teamB: FileSpace = {
    ...teamA,
    id: "dept:team-b",
  };

  it("resolves deterministically to the first (server-ordered) match", () => {
    const result = resolveFileSpace("/Engineering — Platform/specs/api.md", [
      PERSONAL,
      teamA,
      teamB,
    ]);
    expect(result.space?.id).toBe("dept:team-a");
  });

  it("flags the collision so callers can tell it happened", () => {
    const result = resolveFileSpace("/Engineering — Platform/specs/api.md", [
      PERSONAL,
      teamA,
      teamB,
    ]);
    expect(result.ambiguous).toBe(true);
  });

  it("is not flagged in the normal case", () => {
    expect(resolveFileSpace("/Engineering — Platform/x", ALL).ambiguous).toBe(false);
  });

  it("shows the same label either way, so the collision cannot mislabel", () => {
    expect(spaceDisplayName(teamA)).toBe(spaceDisplayName(teamB));
  });
});

describe("spaceDisplayName — mount-name reconstruction", () => {
  it("uses the bare name for a department", () => {
    expect(spaceDisplayName(FINANCE)).toBe("Finance");
  });

  it("uses '<Parent> — <Team>' for a team", () => {
    expect(spaceDisplayName(PLATFORM)).toBe("Engineering — Platform");
  });

  it("does not invent a parent when the server didn't send one", () => {
    expect(spaceDisplayName({ ...PLATFORM, parentName: undefined })).toBe("Platform");
  });

  it("uses the household's own name", () => {
    expect(spaceDisplayName(HOUSEHOLD)).toBe("Household");
  });
});

describe("libraryLabelForPath", () => {
  it("labels a department file", () => {
    expect(libraryLabelForPath("/Finance/Q1/plan.xlsx", ALL)).toBe("Finance");
  });

  it("labels a team file with its parent", () => {
    expect(libraryLabelForPath("/Engineering — Platform/specs/api.md", ALL)).toBe(
      "Engineering — Platform"
    );
  });

  it("returns null for a personal file — no chip, no noise", () => {
    expect(libraryLabelForPath("/Documents/budget.xlsx", ALL)).toBeNull();
  });
});

describe("buildFilesUrl — same contract as the Files page (WARP-1547)", () => {
  it("omits both defaults", () => {
    expect(buildFilesUrl("personal", "/")).toBe("/files");
  });

  it("omits the redundant personal space param", () => {
    expect(buildFilesUrl("personal", "/Documents")).toBe("/files?path=%2FDocuments");
  });

  it("omits the redundant root path", () => {
    expect(buildFilesUrl("dept:finance", "/")).toBe("/files?space=dept%3Afinance");
  });

  it("writes the pair when both are non-default", () => {
    expect(buildFilesUrl("dept:finance", "/Contracts")).toBe(
      "/files?space=dept%3Afinance&path=%2FContracts"
    );
  });
});

describe("filesUrlForEntry — a row click lands in the file's own library", () => {
  it("opens a library file's folder inside that library", () => {
    expect(filesUrlForEntry({ path: "/Finance/Q1/plan.xlsx", isDirectory: false }, ALL)).toBe(
      "/files?space=dept%3Afinance&path=%2FFinance%2FQ1"
    );
  });

  it("opens a library folder as itself", () => {
    expect(filesUrlForEntry({ path: "/Finance/Q1", isDirectory: true }, ALL)).toBe(
      "/files?space=dept%3Afinance&path=%2FFinance%2FQ1"
    );
  });

  it("keeps the HOME-relative path for a department, mount name included", () => {
    // Departments are still listed through personal-space semantics
    // (`fetchFiles` only ever sends `space=shared`), and the groupfolder mount
    // is a real directory in the user's home — so "/Finance" is the path that
    // lists the library, and dropping it would land on the home root instead.
    expect(filesUrlForEntry({ path: "/Finance", isDirectory: true }, ALL)).toBe(
      "/files?space=dept%3Afinance&path=%2FFinance"
    );
  });

  it("drops the path entirely at the SHARED space's root", () => {
    expect(filesUrlForEntry({ path: "/Household", isDirectory: true }, ALL)).toBe(
      "/files?space=shared"
    );
  });

  it("uses the SPACE-RELATIVE path for the shared space", () => {
    // `fetchFiles` sends `space=shared` and the orchestrator prefixes the
    // Household mount server-side, so the home-relative form would double it.
    expect(
      filesUrlForEntry({ path: "/Household/Trips/italy.pdf", isDirectory: false }, ALL)
    ).toBe("/files?space=shared&path=%2FTrips");
  });

  it("keeps the plain personal shape for a home file", () => {
    expect(
      filesUrlForEntry({ path: "/Documents/budget.xlsx", isDirectory: false }, ALL)
    ).toBe("/files?path=%2FDocuments");
  });

  it("routes a top-level personal file to the root", () => {
    expect(filesUrlForEntry({ path: "/notes.txt", isDirectory: false }, ALL)).toBe("/files");
  });
});
