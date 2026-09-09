// Spacing regression guard for the Projects pop-ups + detail panel (WARP-945).
//
// All four Projects surfaces that render inside the shared <Dialog> primitive
// (New project, New item, Delete project, work-item detail) wrapped their body
// in a bare `.pm-scope` div with NO padding, so content sat flush against the
// dialog / side-panel edge — cramped and visually cut off. The fix routes every
// one of them through a single shared `.pm-dialog-body` wrapper that owns the
// surrounding padding (a design-token spacing step), so the spacing is applied
// once on the shared component and covers all four surfaces. These tests pin
// that contract so a future surface can't regress back to a bare wrapper.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { NewItemModal, NewProjectModal, ConfirmDeleteProject } from "./modals";
import { DetailDrawer } from "./detail";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmProject, PmWorkItem } from "./types";

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ states: [], comments: [], activity: [], work_items: [], users: [] }),
    } as Response),
  ),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const PROJECT: PmProject = {
  id: "p1",
  workspaceId: "ws1",
  workspaceSlug: "home",
  department: null,
  name: "Inbox",
  identifier: "INBOX",
  description: null,
  icon: null,
  color: "#6366f1",
  leadId: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p1",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  priority: "none",
  parentId: null,
  cycleId: null,
  department: null,
  assignees: [],
  labels: [],
  startDate: null,
  dueDate: null,
  sortOrder: 1,
  completedAt: null,
  createdById: null,
  commentCount: 0,
  subItemCount: 0,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function wrap(node: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>{node}</PeopleContext.Provider>
    </SWRConfig>,
  );
}

/** The padded body is the SHARED wrapper — every Projects Dialog surface must use it. */
function expectPaddedBody() {
  const dialog = screen.getByRole("dialog");
  const body = dialog.querySelector(".pm-dialog-body");
  expect(body).not.toBeNull();
  // It must also still carry the design-token scope so colors/typography resolve.
  expect(body).toHaveClass("pm-scope");
}

describe("Projects dialog spacing (WARP-945)", () => {
  it("New item modal pads its body via the shared wrapper", () => {
    wrap(<NewItemModal project={PROJECT} onClose={() => undefined} onCreated={() => undefined} />);
    expectPaddedBody();
  });

  it("New project modal pads its body via the shared wrapper", () => {
    wrap(<NewProjectModal onClose={() => undefined} onCreated={() => undefined} />);
    expectPaddedBody();
  });

  it("Delete project confirm pads its body via the shared wrapper", () => {
    wrap(<ConfirmDeleteProject project={PROJECT} onClose={() => undefined} onDeleted={() => undefined} />);
    expectPaddedBody();
  });

  it("work-item detail panel pads its body via the shared wrapper", () => {
    wrap(<DetailDrawer item={ITEM} onClose={() => undefined} onChanged={() => undefined} />);
    expectPaddedBody();
  });
});
