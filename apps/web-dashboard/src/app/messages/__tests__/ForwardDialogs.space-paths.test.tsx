/**
 * WARP-1934 — the forward picker speaks the files API's path vocabulary.
 *
 * ── The defect ──────────────────────────────────────────────────────────
 * Listing entries come back HOME-relative ("/Household/Docs"), but the
 * `path` the picker holds is SPACE-relative: `fetchFiles(path, space)` sends
 * it verbatim and the orchestrator re-prefixes it from `space`
 * (`rootForSpace`). Feeding an entry path straight back therefore asked for
 * "/Household/Household/Docs" — the WARP-1140 trap, which renders as a
 * silently empty folder. Only space-root files were reachable by browsing.
 *
 * The same mismatch rode out on the PICK: `PickedFile.path` was the
 * home-relative entry path while `space` travelled beside it, and
 * ConversationPane sends that pair as `filePath` + `space` — so a forwarded
 * link into a non-personal space resolved one level too deep for the
 * recipient too.
 *
 * The search tab is deliberately unaffected: it sends no `space`, so the
 * registry resolves the raw home-relative path (see PickedFile).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ForwardFileDialog } from "../ForwardDialogs";
import type { FileEntryInfo, FileSpacesResponse } from "@/lib/types";

const { fetchSpacesMock, fetchFilesMock, searchFilesMock, listConversationsMock } =
  vi.hoisted(() => ({
    fetchSpacesMock: vi.fn(),
    fetchFilesMock: vi.fn(),
    searchFilesMock: vi.fn(),
    listConversationsMock: vi.fn(async () => ({ conversations: [] })),
  }));

vi.mock("@/lib/api", () => ({
  fetchSpaces: fetchSpacesMock,
  fetchFiles: fetchFilesMock,
  searchFiles: searchFilesMock,
  listConversations: listConversationsMock,
}));

const SPACES: FileSpacesResponse = {
  sharedAvailable: true,
  spaces: [
    { id: "personal", name: "My Files", root: "/" },
    {
      id: "shared",
      name: "Household",
      root: "/Household",
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

const dir = (path: string, name: string): FileEntryInfo =>
  ({ path, name, isDirectory: true, size: 0 }) as FileEntryInfo;

const file = (path: string, name: string, ncFileId: number): FileEntryInfo =>
  ({ path, name, isDirectory: false, size: 12, ncFileId }) as FileEntryInfo;

beforeEach(() => {
  fetchSpacesMock.mockReset();
  fetchSpacesMock.mockResolvedValue(SPACES);
  fetchFilesMock.mockReset();
  searchFilesMock.mockReset();
  searchFilesMock.mockResolvedValue([]);
});

function renderDialog(onPick = vi.fn()) {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ForwardFileDialog open onClose={vi.fn()} onPick={onPick} />
    </SWRConfig>,
  );
  return onPick;
}

/** Move the picker onto a non-personal space via its own selector. */
async function selectSpace(value: string) {
  const select = await screen.findByLabelText("Files space");
  fireEvent.change(select, { target: { value } });
  // The space change re-keys the listing SWR call; wait for it to land so a
  // subsequent assertion can't read the previous space's request.
  await waitFor(() => expect(fetchFilesMock).toHaveBeenCalledWith("/", value));
}

describe("ForwardFileDialog · space-relative paths (WARP-1934)", () => {
  it("browses INTO a household folder with a space-relative path", async () => {
    // Space root listing: the API answered for "/" + space=shared, and the
    // entries it returns are home-relative.
    fetchFilesMock.mockResolvedValue([dir("/Household/Docs", "Docs")]);
    renderDialog();

    await selectSpace("shared");
    fireEvent.click(await screen.findByText("Docs"));

    await waitFor(() =>
      expect(fetchFilesMock).toHaveBeenCalledWith("/Docs", "shared"),
    );
    // The bug: the home-relative entry path sent verbatim, which the server
    // re-prefixes into "/Household/Household/Docs".
    expect(fetchFilesMock).not.toHaveBeenCalledWith("/Household/Docs", "shared");
  });

  it("does the same for a department library", async () => {
    fetchFilesMock.mockResolvedValue([dir("/Finance/Q1", "Q1")]);
    renderDialog();

    await selectSpace("dept:finance");
    fireEvent.click(await screen.findByText("Q1"));

    await waitFor(() =>
      expect(fetchFilesMock).toHaveBeenCalledWith("/Q1", "dept:finance"),
    );
    expect(fetchFilesMock).not.toHaveBeenCalledWith("/Finance/Q1", "dept:finance");
  });

  it("leaves personal-space paths exactly as they are", async () => {
    // The personal space's root is "/", so there is no prefix to strip and
    // the request must stay byte-identical to its pre-fix shape.
    fetchFilesMock.mockResolvedValue([dir("/Projects", "Projects")]);
    renderDialog();

    fireEvent.click(await screen.findByText("Projects"));

    await waitFor(() =>
      expect(fetchFilesMock).toHaveBeenCalledWith("/Projects", "personal"),
    );
  });

  it("hands the forward a space-relative path next to its space", async () => {
    fetchFilesMock.mockResolvedValue([
      file("/Household/budget.xlsx", "budget.xlsx", 4242),
    ]);
    const onPick = renderDialog();

    await selectSpace("shared");
    fireEvent.click(await screen.findByText("budget.xlsx"));

    // ConversationPane sends this pair as `filePath` + `space`, and the
    // orchestrator re-prefixes `filePath` from `space` — so a home-relative
    // path here resolves one level too deep for the RECIPIENT.
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        ncFileId: 4242,
        path: "/budget.xlsx",
        space: "shared",
      }),
    );
  });

  it("keeps a searched pick home-relative, with no space", async () => {
    fetchFilesMock.mockResolvedValue([]);
    searchFilesMock.mockResolvedValue([
      file("/Household/budget.xlsx", "budget.xlsx", 4242),
    ]);
    const onPick = renderDialog();

    fireEvent.change(await screen.findByLabelText("Search files"), {
      target: { value: "budget" },
    });
    fireEvent.click(await screen.findByText("budget.xlsx"));

    // Search spans every reachable space and results carry no space of their
    // own, so the raw path travels and the registry decides. Translating it
    // against whatever the selector happens to show would be a guess.
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/Household/budget.xlsx",
        space: undefined,
      }),
    );
  });
});
