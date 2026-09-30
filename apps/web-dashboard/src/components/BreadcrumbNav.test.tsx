/**
 * WARP-1267 (T15) — team breadcrumb: `prefixCrumb` renders a non-navigating
 * crumb before "My files" (used for team spaces — "Engineering / Platform / …"
 * even though Nextcloud mounts the team library flat, ADR-029 §D-3).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BreadcrumbNav } from "./BreadcrumbNav";

describe("BreadcrumbNav", () => {
  it("renders no prefix crumb by default", () => {
    render(<BreadcrumbNav path="/Docs" onNavigate={() => {}} />);
    expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
  });

  it("renders a non-navigating prefix crumb when prefixCrumb is set", () => {
    render(
      <BreadcrumbNav path="/Docs" onNavigate={() => {}} prefixCrumb="Engineering" />
    );
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    // Plain text, not a navigation button — clicking it must never fire onNavigate.
    expect(
      screen.queryByRole("button", { name: /^engineering$/i })
    ).not.toBeInTheDocument();
  });

  it("still navigates via the root crumb and path segments with a prefix crumb present", () => {
    const onNavigate = vi.fn();
    render(
      <BreadcrumbNav
        path="/Docs/2026"
        onNavigate={onNavigate}
        prefixCrumb="Engineering"
      />
    );
    screen.getByRole("button", { name: /my files/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("/");
    screen.getByRole("button", { name: /^docs$/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("/Docs");
  });
});

// WARP-1944 — the root crumb names the ACTIVE SPACE, not always "My files".
// Browsing a Workspace/department/team folder showed "My files > Trips" even
// though the user was inside the shared library; the caller now hands the
// active space's display label down. Navigation is unchanged: the root crumb
// still targets the space's root ("/").
describe("BreadcrumbNav — rootLabel (WARP-1944)", () => {
  it('defaults the root crumb to "My files" when no rootLabel is given', () => {
    render(<BreadcrumbNav path="/Docs" onNavigate={() => {}} />);
    expect(screen.getByRole("button", { name: "My files" })).toBeInTheDocument();
  });

  it("renders the supplied space label instead of 'My files'", () => {
    render(
      <BreadcrumbNav path="/Trips" onNavigate={() => {}} rootLabel="Workspace" />
    );
    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.queryByText("My files")).not.toBeInTheDocument();
  });

  it("still navigates to the space root ('/') via the relabelled root crumb", () => {
    const onNavigate = vi.fn();
    render(
      <BreadcrumbNav path="/Trips" onNavigate={onNavigate} rootLabel="Workspace" />
    );
    screen.getByRole("button", { name: "Workspace" }).click();
    expect(onNavigate).toHaveBeenCalledWith("/");
  });
});

// WARP-1338 (UX review) — a volume deep-link lands on /files?path=/<mount-tail>;
// for the live box's legacy pool the tail is the FULL fs UUID, and the crumb
// rendered it raw — the exact GUID-as-primary-label WARP-1337 banned. The
// caller supplies a display mapping; navigation MUST keep using the real path
// (the WebDAV listing is keyed by the raw tail, only the label is friendly).
describe("BreadcrumbNav — labelForSegment (WARP-1338)", () => {
  const GUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";

  it("renders the mapped label instead of the raw segment", () => {
    render(
      <BreadcrumbNav
        path={`/${GUID}`}
        onNavigate={() => {}}
        labelForSegment={(segment, index) =>
          index === 0 && segment === GUID ? "Storage pool" : undefined
        }
      />
    );
    expect(screen.getByText("Storage pool")).toBeInTheDocument();
    expect(screen.queryByText(GUID)).not.toBeInTheDocument();
  });

  it("navigates by the REAL path even when displaying a mapped label", () => {
    const onNavigate = vi.fn();
    render(
      <BreadcrumbNav
        path={`/${GUID}/Photos`}
        onNavigate={onNavigate}
        labelForSegment={(_segment, index) => (index === 0 ? "Storage pool" : undefined)}
      />
    );
    screen.getByRole("button", { name: "Storage pool" }).click();
    expect(onNavigate).toHaveBeenCalledWith(`/${GUID}`);
  });

  it("leaves unmapped segments rendering their raw names", () => {
    render(
      <BreadcrumbNav
        path={`/${GUID}/Photos`}
        onNavigate={() => {}}
        labelForSegment={(_segment, index) => (index === 0 ? "Storage pool" : undefined)}
      />
    );
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });
});

describe("BreadcrumbNav — drop targets (drag-to-move)", () => {
  const INTERNAL = "application/x-droplet-files";
  const dt = (paths: string[]) => ({
    types: [INTERNAL],
    getData: () => JSON.stringify(paths),
    setData: () => {},
    dropEffect: "",
  });

  it("reports a drop on a parent crumb with that crumb's path", () => {
    const onDropItems = vi.fn();
    render(
      <BreadcrumbNav path="/A/B/C" onNavigate={() => {}} onDropItems={onDropItems} />
    );
    fireEvent.drop(screen.getByRole("button", { name: "B" }), { dataTransfer: dt(["/x"]) });
    expect(onDropItems).toHaveBeenCalledWith("/A/B", ["/x"]);
    fireEvent.drop(screen.getByRole("button", { name: "My files" }), {
      dataTransfer: dt(["/y"]),
    });
    expect(onDropItems).toHaveBeenCalledWith("/", ["/y"]);
  });

  it("does not make the current folder a drop target", () => {
    const onDropItems = vi.fn();
    render(
      <BreadcrumbNav path="/A/B" onNavigate={() => {}} onDropItems={onDropItems} />
    );
    // "B" is the current folder — a plain label, not a button.
    expect(screen.queryByRole("button", { name: "B" })).toBeNull();
  });

  it("highlights a crumb the page allows and skips one it vetoes", () => {
    render(
      <BreadcrumbNav
        path="/A/B/C"
        onNavigate={() => {}}
        onDropItems={() => {}}
        canDropOn={(p) => p !== "/A"}
      />
    );
    const ok = screen.getByRole("button", { name: "B" });
    fireEvent.dragEnter(ok, { dataTransfer: dt(["/x"]) });
    expect(ok).toHaveAttribute("data-drop-over", "1");
    const vetoed = screen.getByRole("button", { name: "A" });
    fireEvent.dragEnter(vetoed, { dataTransfer: dt(["/x"]) });
    expect(vetoed).not.toHaveAttribute("data-drop-over");
  });
});
