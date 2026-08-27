/**
 * WARP-1548 — the Libraries group of the Files places rail.
 *
 * The behaviours worth pinning are the ones the design packet supersedes the
 * `SpaceSwitcher` for, plus the two that are binding ADR-029 constraints rather
 * than design taste: Home mode renders nothing at all, and a `failed` library
 * never reaches a plain member.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FileSpace } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));

let spaces: FileSpace[] = [];
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces, sharedAvailable: true, error: undefined, isLoading: false }),
}));

let authRole = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "u1", displayName: "U1", role: authRole } }),
}));

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
}));

import { FilesLibrariesNav } from "./FilesLibrariesNav";

// ── fixtures ────────────────────────────────────────────────────────────────
const personal: FileSpace = { id: "personal", name: "My Files", root: "/", kind: "personal" };
const household: FileSpace = { id: "shared", name: "Household", root: "/Household", kind: "household" };

function dept(name: string, right = "manager", state?: string): FileSpace {
  return {
    id: `dept:${name.toLowerCase()}`,
    name,
    root: `/${name}`,
    kind: "department",
    right,
    state,
  };
}
function team(name: string, parentName: string, right = "reader"): FileSpace {
  return {
    id: `dept:${name.toLowerCase()}`,
    name,
    root: `/${parentName} — ${name}`,
    kind: "team",
    parentName,
    right,
  };
}

const PRACTICE = [
  personal,
  household,
  dept("Clinical", "contributor"),
  team("Ortho", "Clinical"),
  dept("Billing", "reader"),
  dept("Front Desk", "manager"),
];

function renderNav(pathname = "/files") {
  return render(<FilesLibrariesNav pathname={pathname} />);
}

beforeEach(() => {
  spaces = [...PRACTICE];
  authRole = "owner";
  search = new URLSearchParams();
});

describe("Home mode stays pixel-identical (ADR-029 §5)", () => {
  it("renders nothing at all with a single space", () => {
    spaces = [personal];
    const { container } = renderNav();
    // Not "renders an empty group" — no caption, no nav landmark, nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing with no spaces resolved yet", () => {
    spaces = [];
    const { container } = renderNav();
    expect(container).toBeEmptyDOMElement();
  });

  it("appears once there are two libraries to move between", () => {
    spaces = [personal, household];
    renderNav();
    expect(screen.getByRole("navigation", { name: "Libraries" })).toBeInTheDocument();
  });
});

describe("every department and team is visible — no overflow menu", () => {
  it("shows all four libraries at once past the switcher's 3-space threshold", () => {
    renderNav();
    const nav = screen.getByRole("navigation", { name: "Libraries" });
    // The exact case the packet supersedes: past three spaces SpaceSwitcher
    // collapses these into a "Spaces ▾" menu. Here they are all just present.
    for (const label of ["My Files", "Workspace", "Clinical", "Ortho", "Billing", "Front Desk"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(within(nav).queryByRole("button")).toBeNull();
  });

  it("renders the household space as 'Workspace', never its raw name", () => {
    renderNav();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Household")).toBeNull();
  });

  it("orders departments alphabetically with each team under its parent", () => {
    renderNav();
    const nav = screen.getByRole("navigation", { name: "Libraries" });
    const labels = Array.from(nav.querySelectorAll("a, [aria-disabled]")).map(
      (el) => el.textContent?.replace(/Reader|Contributor|Manager/g, "").trim()
    );
    expect(labels).toEqual([
      "My Files",
      "Workspace",
      "Billing",
      "Clinical",
      "Ortho", // nested under Clinical, not sorted to the end
      "Front Desk",
    ]);
  });

  it("still renders a team whose parent department isn't visible", () => {
    // The switcher's orphan fallback: a library you can open but cannot see is
    // worse than an oddly-placed row.
    spaces = [personal, household, team("Ortho", "Clinical")];
    renderNav();
    expect(screen.getByText("Ortho")).toBeInTheDocument();
  });
});

describe("rights and state are honest, never silent absence", () => {
  it("renders the right as a neutral text chip, per library", () => {
    renderNav();
    // Scoped per row: two libraries in the fixture are Reader (Ortho, Billing),
    // so a bare getByText would be ambiguous — and the point is that the chip
    // belongs to its own row, not that the word appears somewhere.
    const rowFor = (name: string) =>
      screen.getByRole("link", { name: new RegExp(name) });
    expect(rowFor("Clinical")).toHaveTextContent("Contributor");
    expect(rowFor("Billing")).toHaveTextContent("Reader");
    expect(rowFor("Front Desk")).toHaveTextContent("Manager");
    // Personal has no right and must not invent one.
    expect(rowFor("My Files").textContent).toBe("My Files");
  });

  it("shows a provisioning library as a disabled row that says why", () => {
    spaces = [personal, household, dept("Radiology", "manager", "provisioning")];
    renderNav();
    expect(screen.getByText("Setting up…")).toBeInTheDocument();
    // Not browsable (fail-closed), so not a link that would 403.
    expect(screen.queryByRole("link", { name: /Radiology/ })).toBeNull();
  });

  it("shows a failed library to an owner", () => {
    spaces = [personal, household, dept("Lab", "manager", "failed")];
    renderNav();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("never leaks a failed library to a plain member", () => {
    authRole = "family";
    spaces = [personal, household, dept("Lab", "manager", "failed")];
    renderNav();
    expect(screen.queryByText("Lab")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });
});

describe("links go through buildFilesUrl", () => {
  it("links a department to its own space, at its root", () => {
    renderNav();
    const link = screen.getByRole("link", { name: /Clinical/ });
    expect(link).toHaveAttribute("href", "/files?space=dept%3Aclinical");
  });

  it("links personal to bare /files, carrying no redundant params", () => {
    renderNav();
    expect(screen.getByRole("link", { name: /My Files/ })).toHaveAttribute("href", "/files");
  });

  it("never emits a path param for a library root", () => {
    // The double-prefix trap: a hand-rolled link would send the mount as
    // `?path=`, the server would re-prefix it, and the page would render a
    // silently empty folder. buildFilesUrl drops `path` at the root.
    renderNav();
    for (const link of screen.getAllByRole("link")) {
      const qs = new URLSearchParams(link.getAttribute("href")!.split("?")[1] ?? "");
      expect(qs.get("path")).toBeNull();
    }
  });
});

describe("accessibility", () => {
  it("is a navigation landmark, not a tablist", () => {
    renderNav();
    expect(screen.getByRole("navigation", { name: "Libraries" })).toBeInTheDocument();
    // The deliberate divergence from the shipped SpaceSwitcher (addendum §2.1):
    // each library is a distinct URL, which is navigation, not tab semantics.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("marks the active library with aria-current=page", () => {
    search = new URLSearchParams("space=dept:clinical");
    renderNav();
    expect(screen.getByRole("link", { name: /Clinical/ })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: /Billing/ })).not.toHaveAttribute("aria-current");
  });

  it("treats a bare /files as My Files being active", () => {
    renderNav();
    expect(screen.getByRole("link", { name: /My Files/ })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("marks nothing active on a sub-route like /files/trash", () => {
    // Trash is not a library; highlighting one there would claim a location
    // the user is not in.
    renderNav("/files/trash");
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });
});
