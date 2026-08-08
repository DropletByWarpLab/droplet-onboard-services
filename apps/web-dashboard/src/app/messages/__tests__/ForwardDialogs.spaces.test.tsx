/**
 * WARP-1808 (UX review pin) — the "Forward a file" space picker maps the
 * same /api/files/spaces payload the Files surface renders, so its option
 * TEXT must use the display name too: the household-kind space reads
 * "Workspace" (keyed off `kind`, never the raw server name), while every
 * other space renders verbatim. The option VALUE — what feeds back into the
 * files API as `space` — stays the raw space id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ForwardFileDialog } from "../ForwardDialogs";
import type { FileSpacesResponse } from "@/lib/types";

const { fetchSpacesMock, fetchFilesMock, searchFilesMock, listConversationsMock } =
  vi.hoisted(() => ({
    fetchSpacesMock: vi.fn(),
    fetchFilesMock: vi.fn(async () => []),
    searchFilesMock: vi.fn(async () => []),
    listConversationsMock: vi.fn(async () => ({ conversations: [] })),
  }));

vi.mock("@/lib/api", () => ({
  fetchSpaces: fetchSpacesMock,
  fetchFiles: fetchFilesMock,
  searchFiles: searchFilesMock,
  listConversations: listConversationsMock,
}));

// The shared space keeps its RAW server name in the payload (data contract);
// a name that differs from "Household" proves the mapping keys off kind.
const SPACES: FileSpacesResponse = {
  sharedAvailable: true,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    {
      id: "shared",
      name: "Family Files",
      root: "/Family Files",
      kind: "household",
      state: "active",
    },
    {
      id: "dept:finance",
      name: "Finance",
      root: "/Finance",
      kind: "department",
      state: "active",
      right: "contributor",
      isMember: true,
    },
  ],
};

beforeEach(() => {
  fetchSpacesMock.mockReset();
  fetchSpacesMock.mockResolvedValue(SPACES);
  fetchFilesMock.mockClear();
});

// Fresh SWR cache per render — the dialog's "/api/files/spaces" key is
// constant, so without this a test would read the previous test's payload.
function renderDialog() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ForwardFileDialog open onClose={vi.fn()} onPick={vi.fn()} />
    </SWRConfig>,
  );
}

describe("ForwardFileDialog — space picker display names (WARP-1808)", () => {
  it("renders the household-kind space as 'Workspace' while keeping the raw id as the option value", async () => {
    renderDialog();
    const select = await screen.findByLabelText("Files space");

    const workspace = within(select).getByRole("option", { name: "Workspace" });
    expect(workspace).toHaveValue("shared");
    // The raw server name never reaches the user.
    expect(within(select).queryByRole("option", { name: "Family Files" })).toBeNull();
  });

  it("renders every non-household space's name verbatim", async () => {
    renderDialog();
    const select = await screen.findByLabelText("Files space");

    expect(within(select).getByRole("option", { name: "My Files" })).toHaveValue("personal");
    expect(within(select).getByRole("option", { name: "Finance" })).toHaveValue("dept:finance");
  });
});
