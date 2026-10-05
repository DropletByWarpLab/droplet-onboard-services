// WARP-3522 — the cross-project "Views" index: its three states (brief §3.10)
// and what each row opens.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PmSavedViewDto } from "@droplet/shared-types";
import { ViewsIndex } from "./ViewsIndex";
import type { PmProject } from "./types";

const PROJECT = { id: "p1", name: "Onboarding", identifier: "INBOX", archived: false } as PmProject;

function view(over: Partial<PmSavedViewDto>): PmSavedViewDto {
  return {
    id: "v",
    projectId: "p1",
    ownerId: "u1",
    scope: "PERSONAL",
    name: "A view",
    layout: "BOARD",
    filter: { and: [] },
    groupBy: null,
    sortBy: null,
    columns: null,
    sortOrder: 0,
    canEdit: true,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

const base = {
  projects: [PROJECT],
  loading: false,
  error: undefined as unknown,
  onOpen: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onRetry: vi.fn(),
};
const render_ = (props: Partial<Parameters<typeof ViewsIndex>[0]>) =>
  render(<div className="pm-scope"><ViewsIndex views={[]} {...base} {...props} /></div>);

describe("ViewsIndex", () => {
  it("always offers the workspace-wide list — the only place a cross-project view is made", () => {
    const onOpenWorkspace = vi.fn();
    render_({ views: [], onOpenWorkspace });
    fireEvent.click(screen.getByRole("button", { name: /All work across projects/ }));
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it("empty: says where views come from, and does not blame anyone", () => {
    render_({ views: [] });
    expect(screen.getByText("No saved views yet.")).toBeInTheDocument();
    expect(screen.getByText(/choose Save view/)).toBeInTheDocument();
  });

  it("loading: skeleton rows, not a spinner — and the door is still there", () => {
    render_({ views: undefined, loading: true });
    expect(screen.getByLabelText("Loading views")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /All work across projects/ })).toBeInTheDocument();
  });

  it("error: calm copy and Try again", () => {
    const onRetry = vi.fn();
    render_({ views: undefined, error: new Error("boom"), onRetry });
    expect(screen.getByText("Couldn't load your views.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("groups shared and personal views, each row naming its project and layout", () => {
    render_({
      views: [
        view({ id: "a", name: "Team board", scope: "SHARED", layout: "BOARD" }),
        view({ id: "b", name: "My list", scope: "PERSONAL", layout: "LIST" }),
        view({ id: "c", name: "Everything", projectId: null, scope: "PERSONAL", layout: "LIST" }),
      ],
    });
    const shared = screen.getByRole("region", { name: "Shared" });
    expect(within(shared).getByRole("button", { name: /Team board/ })).toHaveTextContent("Onboarding");
    expect(within(shared).getByRole("button", { name: /Team board/ })).toHaveTextContent("Board");
    expect(within(shared).getByRole("button", { name: /Team board \(shared\)/ })).toBeInTheDocument();
    const yours = screen.getByRole("region", { name: "Yours" });
    expect(within(yours).getByRole("button", { name: /My list/ })).toHaveTextContent("List");
    expect(within(yours).getByRole("button", { name: /Everything/ })).toHaveTextContent("All projects");
  });

  it("omits a section with nothing in it", () => {
    render_({ views: [view({ id: "b", scope: "PERSONAL" })] });
    expect(screen.queryByRole("region", { name: "Shared" })).toBeNull();
    expect(screen.getByRole("region", { name: "Yours" })).toBeInTheDocument();
  });

  it("a row opens its view", () => {
    const onOpen = vi.fn();
    const v = view({ id: "b", name: "My list" });
    render_({ views: [v], onOpen });
    fireEvent.click(screen.getByRole("button", { name: /My list/ }));
    expect(onOpen).toHaveBeenCalledWith(v);
  });
});
