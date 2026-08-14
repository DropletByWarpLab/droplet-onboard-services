/**
 * WARP-883 (ADR-027 WS-5) + WARP-1261 (spaces v2) — Files space switcher
 * (My Files / Household / departments / teams).
 *
 * The switcher sits atop the Files surface and toggles the active space. It
 * only appears when there is more than one usable space to switch between;
 * with only the personal space it renders nothing (no lone toggle). "Usable"
 * is derived from the v2 wire contract — personal is always usable, every
 * other space is usable once its provisioning `state` is "active" (there is no
 * longer an `available` boolean on the wire). Selecting a space fires onChange
 * with the space id so the page can re-root the listing.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { FileSpace } from "@/lib/types";

const PERSONAL: FileSpace = {
  id: "personal",
  name: "My Files",
  root: "/",
};
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};
const DEPARTMENT: FileSpace = {
  id: "dept:00000000-0000-0000-0000-000000000001",
  name: "Engineering",
  root: "/Engineering",
  kind: "department",
  state: "active",
  right: "contributor",
};

describe("SpaceSwitcher", () => {
  it("renders both spaces when the shared space is available", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /workspace/i })).toBeInTheDocument();
  });

  it("marks the active space as selected", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="shared"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /workspace/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("fires onChange with the chosen space id", () => {
    const onChange = vi.fn();
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED]}
        active="personal"
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /workspace/i }));
    expect(onChange).toHaveBeenCalledWith("shared");
  });

  it("renders nothing when the only shared space is not yet active", () => {
    const { container } = render(
      <SpaceSwitcher
        spaces={[PERSONAL, { ...SHARED, state: "pending" }]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("renders active department spaces returned by the v2 API", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, DEPARTMENT]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /engineering/i })
    ).toBeInTheDocument();
  });

  it("omits non-active spaces but keeps active ones", () => {
    render(
      <SpaceSwitcher
        spaces={[
          PERSONAL,
          SHARED,
          { ...DEPARTMENT, state: "archiving" },
        ]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /workspace/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /engineering/i })
    ).not.toBeInTheDocument();
  });

  it("renders nothing when only the personal space is present", () => {
    const { container } = render(
      <SpaceSwitcher spaces={[PERSONAL]} active="personal" onChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // WARP-1808 — the shared space's server name is a data contract (mounts,
  // grouping, prefix math all key off it), but the RENDERED label is always
  // "Workspace" for the household kind. Keyed off `kind`, never the name, so
  // a renamed server row still reads "Workspace".
  it("renders the household-kind space as 'Workspace' regardless of its server name", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, { ...SHARED, name: "Family" }]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /^workspace$/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /family/i })).not.toBeInTheDocument();
  });

  it("never maps a non-household space's name — even one literally named 'Household'", () => {
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, { ...DEPARTMENT, name: "Household" }]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("tab", { name: /^household$/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^workspace$/i })).not.toBeInTheDocument();
  });

  it("stays segmented (no Spaces menu) with exactly 3 active spaces — ≤3 regression", () => {
    const FINANCE: FileSpace = {
      id: "dept:finance",
      name: "Finance",
      root: "/Finance",
      kind: "department",
      state: "active",
      right: "reader",
      isMember: true,
    };
    render(
      <SpaceSwitcher
        spaces={[PERSONAL, SHARED, FINANCE]}
        active="personal"
        onChange={() => {}}
      />
    );
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: /finance/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^spaces$/i })).not.toBeInTheDocument();
  });
});

// WARP-1267 (T15) — >3 spaces collapses the segmented control's third
// segment to a "Spaces" menu grouping departments with nested teams,
// honest provisioning/failed state chips, and a right-aligned rights chip.
describe("SpaceSwitcher — Spaces menu (>3 spaces)", () => {
  const FINANCE: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "reader",
    isMember: true,
  };
  const ENGINEERING: FileSpace = {
    id: "dept:eng",
    name: "Engineering",
    root: "/Engineering",
    kind: "department",
    state: "active",
    right: "contributor",
    isMember: true,
  };
  const PLATFORM: FileSpace = {
    id: "dept:eng-platform",
    name: "Platform",
    root: "/Engineering — Platform",
    kind: "team",
    state: "active",
    right: "manager",
    isMember: true,
    parentName: "Engineering",
  };
  const LEGAL_PROVISIONING: FileSpace = {
    id: "dept:legal",
    name: "Legal",
    root: "/Legal",
    kind: "department",
    state: "provisioning",
    right: "reader",
    isMember: true,
  };
  const RECORDS_FAILED: FileSpace = {
    id: "dept:records",
    name: "Records",
    root: "/Records",
    kind: "department",
    state: "failed",
    isMember: false,
  };
  const SIX_SPACES = [
    PERSONAL,
    SHARED,
    FINANCE,
    ENGINEERING,
    PLATFORM,
    LEGAL_PROVISIONING,
    RECORDS_FAILED,
  ];

  it("keeps My Files + the shared Workspace pinned and collapses the rest behind a Spaces trigger", () => {
    render(<SpaceSwitcher spaces={SIX_SPACES} active="personal" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /spaces/i })).toBeInTheDocument();
    // Department rows aren't in the DOM until the menu opens.
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("lists departments with nested teams, a rights chip, and no failed row for a non-admin viewer", () => {
    render(
      <SpaceSwitcher
        spaces={SIX_SPACES}
        active="personal"
        onChange={() => {}}
        isOwnerOrAdmin={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));
    expect(screen.getByRole("menuitem", { name: /finance/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /engineering/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /platform/i })).toBeInTheDocument();
    // "Reader" rights chip renders for Finance.
    expect(screen.getByRole("menuitem", { name: /finance/i })).toHaveTextContent("Reader");
    // Provisioning is visible (the caller has a right on Legal).
    expect(screen.getByRole("menuitem", { name: /legal/i })).toBeInTheDocument();
    expect(screen.getByText("Setting up…")).toBeInTheDocument();
    // Failed is admin/owner-only — never leaked to a plain member.
    expect(screen.queryByRole("menuitem", { name: /records/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  });

  it("shows the failed row, loudly, to an owner/admin viewer", () => {
    render(
      <SpaceSwitcher
        spaces={SIX_SPACES}
        active="personal"
        onChange={() => {}}
        isOwnerOrAdmin
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));
    const recordsRow = screen.getByRole("menuitem", { name: /records/i });
    expect(recordsRow).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("a provisioning row is disabled and does not fire onChange when clicked", () => {
    const onChange = vi.fn();
    render(
      <SpaceSwitcher spaces={SIX_SPACES} active="personal" onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));
    const legalRow = screen.getByRole("menuitem", { name: /legal/i });
    expect(legalRow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(legalRow);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking an active department row fires onChange and closes the menu", () => {
    const onChange = vi.fn();
    render(
      <SpaceSwitcher spaces={SIX_SPACES} active="personal" onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /engineering/i }));
    expect(onChange).toHaveBeenCalledWith("dept:eng");
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("shows the active menu space's name in the trigger label instead of 'Spaces'", () => {
    render(
      <SpaceSwitcher spaces={SIX_SPACES} active="dept:finance" onChange={() => {}} />
    );
    expect(screen.getByRole("button", { name: /finance/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^spaces$/i })).not.toBeInTheDocument();
  });

  it("closes the menu on Escape", () => {
    render(<SpaceSwitcher spaces={SIX_SPACES} active="personal" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
