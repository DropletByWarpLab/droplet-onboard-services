/**
 * ShareDialog tests — UNION of two independent suites:
 *
 * WARP-879 / WS-1 — ShareDialog internal-sharing UI.
 *   The dialog gains a Person / Link mode. In Person mode it loads the
 *   household roster from fetchShareRecipients() and creates a named-member
 *   share (shareType:0 + shareWith). Link mode keeps the public-link path
 *   (shareType:3) unchanged.
 *   Covered:
 *     - defaults to Person mode and loads recipients on open
 *     - Create in Person mode sends { shareType:0, shareWith, permissions }
 *     - a person share (shareType:0) renders a chip, no copy-link affordance
 *     - Link mode still creates with shareType:3
 *     - empty roster → friendly empty state (no error styling)
 *     - Create is disabled until a recipient is selected (Person mode)
 *
 * WARP-883 (WS-1 fast-follow) — ShareDialog renders shares ALREADY on the file.
 *   The Files page now fetches the file's existing shares and passes them as
 *   `existingShares`; this pins that the dialog lists them on open (with their
 *   link + permissions).
 *
 * WARP-1543 — the Person tab selects MULTIPLE recipients per share action.
 *   See the describe block at the foot of this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ShareDetail, ShareRecipient } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  createShare: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
  fetchShareRecipients: vi.fn(),
}));

// ConfirmDialog is irrelevant to these cases — render nothing.
vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/lib/friendly-errors", () => ({
  translateError: (err: unknown) =>
    err instanceof Error ? err.message : "Something went wrong",
}));

import { createShare, updateShare, fetchShareRecipients } from "@/lib/api";
import { ShareDialog, sendablePermissions } from "./ShareDialog";

const RECIPIENTS: ShareRecipient[] = [
  { shareWith: "romain", displayName: "Romain", email: "romain@example.com" },
  { shareWith: "samantha", displayName: "Samantha", email: null },
];

function makePersonShare(overrides: Partial<ShareDetail> = {}): ShareDetail {
  return {
    id: 21,
    url: null,
    token: null,
    shareType: 0,
    permissions: 17,
    path: "/report.pdf",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: "romain",
    shareWithDisplayName: "Romain",
    uidOwner: "stef",
    ownerDisplayName: "Stefan",
    stime: 1712860391,
    ...overrides,
  };
}

function makeLinkShare(overrides: Partial<ShareDetail> = {}): ShareDetail {
  return {
    id: 30,
    url: "https://nextcloud/s/abc",
    token: "abc",
    shareType: 3,
    permissions: 1,
    path: "/report.pdf",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: null,
    shareWithDisplayName: null,
    uidOwner: "stef",
    ownerDisplayName: "Stefan",
    stime: 1712860391,
    ...overrides,
  };
}

// WARP-883 factory — a public-link share with droplet-ai.local host + null stime.
function share(overrides: Partial<ShareDetail> = {}): ShareDetail {
  return {
    id: 7,
    url: "https://droplet-ai.local/s/abc123",
    token: "abc123",
    shareType: 3,
    permissions: 1,
    path: "/Documents/report.pdf",
    expireDate: null,
    hasPassword: false,
    note: null,
    shareWith: null,
    shareWithDisplayName: null,
    uidOwner: "alice",
    ownerDisplayName: "Alice",
    stime: null,
    ...overrides,
  };
}

const fetchRecipientsMock = fetchShareRecipients as unknown as ReturnType<typeof vi.fn>;
const createShareMock = createShare as unknown as ReturnType<typeof vi.fn>;
const updateShareMock = updateShare as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchRecipientsMock.mockResolvedValue(RECIPIENTS);
  createShareMock.mockResolvedValue(makePersonShare());
  updateShareMock.mockResolvedValue(undefined);
});

function renderDialog(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  return render(
    <ShareDialog
      filePath="/report.pdf"
      fileName="report.pdf"
      existingShares={[]}
      onClose={vi.fn()}
      onChange={vi.fn()}
      {...props}
    />,
  );
}

describe("WARP-879 — ShareDialog internal sharing", () => {
  it("defaults to Person mode and loads the member roster", async () => {
    renderDialog();
    expect(fetchRecipientsMock).toHaveBeenCalled();
    // WARP-1808 — the picker is labelled with business vocabulary.
    expect(await screen.findByText("Workspace members")).toBeInTheDocument();
    // Roster members surface once loaded.
    expect(await screen.findByText("Romain")).toBeInTheDocument();
    expect(screen.getByText("Samantha")).toBeInTheDocument();
  });

  it("Create in Person mode sends { shareType:0, shareWith, permissions }", async () => {
    renderDialog();
    // pick Romain from the roster
    const romain = await screen.findByText("Romain");
    fireEvent.click(romain);

    const createBtn = screen.getByRole("button", { name: "Share" });
    fireEvent.click(createBtn);

    await waitFor(() => expect(createShareMock).toHaveBeenCalled());
    const [path, opts] = createShareMock.mock.calls[0];
    expect(path).toBe("/report.pdf");
    expect(opts).toMatchObject({ shareType: 0, shareWith: "romain" });
    expect(typeof opts.permissions).toBe("number");
  });

  it("renders a person share as a chip with no copy-link affordance", async () => {
    renderDialog({ existingShares: [makePersonShare()] });
    // the recipient's display name is shown as a chip
    expect(await screen.findAllByText("Romain")).not.toHaveLength(0);
    // no copy-link button for a person share
    expect(screen.queryByTitle(/copy link/i)).not.toBeInTheDocument();
  });

  it("still keeps the copy-link row for a public link share (shareType:3)", async () => {
    renderDialog({ existingShares: [makeLinkShare()] });
    expect(await screen.findByTitle(/copy link/i)).toBeInTheDocument();
  });

  it("Link mode creates with shareType:3", async () => {
    createShareMock.mockResolvedValue(makeLinkShare());
    renderDialog();
    // switch to Link mode via the exact toggle label
    const linkTab = await screen.findByRole("button", { name: "Link" });
    fireEvent.click(linkTab);

    // the footer action becomes "Create link"
    const createBtn = screen.getByRole("button", { name: "Create link" });
    fireEvent.click(createBtn);

    await waitFor(() => expect(createShareMock).toHaveBeenCalled());
    const [, opts] = createShareMock.mock.calls[0];
    expect(opts.shareType).toBe(3);
    expect(opts.shareWith).toBeUndefined();
  });

  it("shows a friendly empty state when there are no other workspace members", async () => {
    fetchRecipientsMock.mockResolvedValue([]);
    renderDialog();
    expect(
      await screen.findByText(/no other workspace members yet/i),
    ).toBeInTheDocument();
  });

  it("disables Create in Person mode until a recipient is chosen", async () => {
    renderDialog();
    await screen.findByText("Romain");
    const createBtn = screen.getByRole("button", { name: "Share" });
    expect(createBtn).toBeDisabled();

    fireEvent.click(screen.getByText("Romain"));
    expect(createBtn).not.toBeDisabled();
  });
});

describe("ShareDialog — existing shares (WS-1 fast-follow)", () => {
  it("lists the pre-existing share link on open", () => {
    render(
      <ShareDialog
        filePath="/Documents/report.pdf"
        fileName="report.pdf"
        existingShares={[share()]}
        onClose={() => {}}
      />
    );
    // #692's rewrite renames the existing-shares heading "Active links" → "Shared with"
    // (the section now also covers named-member shares, not only public links).
    expect(screen.getByText(/shared with/i)).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://droplet-ai.local/s/abc123")
    ).toBeInTheDocument();
  });

  it("shows no existing-shares section when there are no existing shares", () => {
    render(
      <ShareDialog
        filePath="/Documents/report.pdf"
        fileName="report.pdf"
        existingShares={[]}
        onClose={() => {}}
      />
    );
    expect(screen.queryByText(/shared with/i)).not.toBeInTheDocument();
  });
});

/**
 * WARP-1148/1149 — Nextcloud rejects single-FILE shares that carry the CREATE
 * or DELETE permission bits (generalCreateChecks: "File shares cannot have
 * create or delete permissions"), so the "Full access" preset (31) could never
 * be created on a file — the exact Share-dialog dead end behind WARP-1148.
 * The dialog now masks CREATE|DELETE out of the outgoing bitmask when the
 * target is a file (isDirectory falsy), and keeps the full mask for folders.
 */
describe("WARP-1148/1149 — file shares never send CREATE/DELETE permission bits", () => {
  // WARP-1601 renamed the file-side top level ("Full access" → "Can edit +
  // reshare") because 31 is unrepresentable on a file. The masking contract is
  // unchanged and still pinned below — it is now the last line of defence
  // rather than the everyday path, so it is also unit-tested directly.
  it("sendablePermissions strips CREATE|DELETE for a FILE and passes a FOLDER through", () => {
    expect(sendablePermissions(31, false)).toBe(19);
    expect(sendablePermissions(15, false)).toBe(3);
    expect(sendablePermissions(31, true)).toBe(31);
    expect(sendablePermissions(19, false)).toBe(19);
  });

  it("Link mode + top level on a FILE sends permissions without CREATE|DELETE (19)", async () => {
    createShareMock.mockResolvedValue(makeLinkShare());
    renderDialog(); // isDirectory defaults to false (a file)
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Can edit + reshare" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(createShareMock).toHaveBeenCalled());
    const [, opts] = createShareMock.mock.calls[0];
    // READ|UPDATE|SHARE — the most-capable mask Nextcloud accepts on a file.
    expect(opts.permissions).toBe(19);
  });

  it("Link mode + 'Full access' on a FOLDER keeps the full mask (31)", async () => {
    createShareMock.mockResolvedValue(makeLinkShare());
    renderDialog({ filePath: "/Trips", fileName: "Trips", isDirectory: true });
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(createShareMock).toHaveBeenCalled());
    const [, opts] = createShareMock.mock.calls[0];
    expect(opts.permissions).toBe(31);
  });

  it("Person mode + top level on a FILE also sends 19, never CREATE|DELETE", async () => {
    renderDialog();
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByRole("button", { name: "Can edit + reshare" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => expect(createShareMock).toHaveBeenCalled());
    const [, opts] = createShareMock.mock.calls[0];
    expect(opts.permissions).toBe(19);
  });
});

/**
 * WARP-939 — the access-level dropdown on an EXISTING share must reflect the
 * share's real Nextcloud permission bitmask, and let the user pick any preset.
 *
 * Nextcloud returns raw OCS permission masks that almost always carry the SHARE
 * bit (16) and, for folders, CREATE/DELETE bits — e.g. a read-only person share
 * is permissions=17 (READ|SHARE), an editable one is 19 (READ|UPDATE|SHARE).
 * The dropdown's <option> values were exact-match (1 / 3 / 31), so a real mask
 * like 17 or 19 matched NO option — the controlled <select> fell back to the
 * first option ("View only") and edits never reflected. These pin that the
 * select snaps a raw mask to the nearest preset for both rendering and editing.
 */
describe("WARP-939 — existing-share access-level dropdown reflects real masks", () => {
  function findAccessSelect(): HTMLSelectElement {
    const select = screen
      .getAllByRole("combobox")
      .find((el) =>
        Array.from((el as HTMLSelectElement).options).some(
          (o) => o.textContent === "View only",
        ),
      ) as HTMLSelectElement | undefined;
    if (!select) throw new Error("access-level select not found");
    return select;
  }

  // WARP-1601: on a FOLDER the SHARE bit is still ignored when snapping, so a
  // raw 19 is "Can edit" exactly as WARP-939 pinned. (On a FILE, 19 now has an
  // option of its own — see the WARP-1601 block below.)
  it("shows 'Can edit' for a FOLDER share whose raw mask is 19 (READ|UPDATE|SHARE)", () => {
    render(
      <ShareDialog
        filePath="/Trips"
        fileName="Trips"
        isDirectory
        existingShares={[makePersonShare({ permissions: 19 })]}
        onClose={() => {}}
      />,
    );
    const select = findAccessSelect();
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toBe("Can edit");
  });

  it("shows 'View only' for a person share whose raw mask is 17 (READ|SHARE)", () => {
    render(
      <ShareDialog
        filePath="/report.pdf"
        fileName="report.pdf"
        existingShares={[makePersonShare({ permissions: 17 })]}
        onClose={() => {}}
      />,
    );
    const select = findAccessSelect();
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toBe("View only");
  });

  it("shows 'Full access' for a folder share whose raw mask is 31 (all bits)", () => {
    render(
      <ShareDialog
        filePath="/Trips"
        fileName="Trips"
        isDirectory
        existingShares={[makePersonShare({ permissions: 31 })]}
        onClose={() => {}}
      />,
    );
    const select = findAccessSelect();
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toBe("Full access");
  });

  it("never leaves the access-level select unselected for a real mask", () => {
    render(
      <ShareDialog
        filePath="/report.pdf"
        fileName="report.pdf"
        existingShares={[makePersonShare({ permissions: 17 })]}
        onClose={() => {}}
      />,
    );
    const select = findAccessSelect();
    // A controlled <select> whose value matches no <option> reports
    // selectedIndex 0 but value "" in jsdom; pin a real selection instead.
    expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(select.value).not.toBe("");
  });
});

/**
 * WARP-1601 — the access dropdown must be file-aware.
 *
 * "Full access" (31) carries CREATE|DELETE, which Nextcloud rejects on a single
 * FILE. The dialog masked those bits on the way out (→ 19) while snapping 19
 * back to "Can edit" on the way in, so on a file "Can edit" and "Full access"
 * rendered identically — yet switching between them silently granted or revoked
 * the recipient's re-share bit. Files now offer the level that actually exists
 * in storage ("Can edit + reshare" = 19) and never offer "Full access"; folders
 * keep their three. Every visible option is assignable and round-trips.
 */
describe("WARP-1601 — file-aware access levels", () => {
  const FILE_LABELS = ["View only", "Can edit", "Can edit + reshare"];
  const FOLDER_LABELS = ["View only", "Can edit", "Full access"];

  function accessSelects(): HTMLSelectElement[] {
    return screen.getAllByRole("combobox", {
      name: /access level/i,
    }) as HTMLSelectElement[];
  }

  const optionLabels = (s: HTMLSelectElement) =>
    Array.from(s.options).map((o) => o.textContent);

  const selectedLabel = (s: HTMLSelectElement) =>
    s.options[s.selectedIndex]?.textContent;

  function renderFor(
    isDirectory: boolean,
    existingShares: ShareDetail[] = [],
  ) {
    return render(
      <ShareDialog
        filePath={isDirectory ? "/Trips" : "/report.pdf"}
        fileName={isDirectory ? "Trips" : "report.pdf"}
        isDirectory={isDirectory}
        existingShares={existingShares}
        onClose={() => {}}
      />,
    );
  }

  describe("option set", () => {
    it("a FILE offers View only / Can edit / Can edit + reshare in BOTH selects", () => {
      renderFor(false, [makePersonShare(), makeLinkShare()]);
      const selects = accessSelects();
      // one for the person row, one for the link row — treated identically
      expect(selects).toHaveLength(2);
      for (const select of selects) {
        expect(optionLabels(select)).toEqual(FILE_LABELS);
      }
    });

    it("a FILE never offers 'Full access' — in the selects or the create form", () => {
      renderFor(false, [makePersonShare(), makeLinkShare()]);
      // Absent rather than greyed: a file has no contents to create or delete,
      // so the level could never become available.
      expect(
        screen.queryByRole("button", { name: "Full access" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Can edit + reshare" }),
      ).toBeInTheDocument();
      for (const select of accessSelects()) {
        expect(optionLabels(select)).not.toContain("Full access");
      }
    });

    it("a FOLDER keeps View only / Can edit / Full access in BOTH selects", () => {
      renderFor(true, [makePersonShare(), makeLinkShare()]);
      const selects = accessSelects();
      expect(selects).toHaveLength(2);
      for (const select of selects) {
        expect(optionLabels(select)).toEqual(FOLDER_LABELS);
      }
      expect(
        screen.queryByRole("button", { name: "Can edit + reshare" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Full access" }),
      ).toBeInTheDocument();
    });
  });

  describe("round-trip — pick X, see X after save and after reopening", () => {
    async function pickAndAssertRoundTrip(
      isDirectory: boolean,
      from: number,
      to: number,
      label: string,
      makeShare: (o: Partial<ShareDetail>) => ShareDetail,
      shareId: number,
    ) {
      const { unmount } = renderFor(isDirectory, [makeShare({ permissions: from })]);
      const select = accessSelects()[0];
      fireEvent.change(select, { target: { value: String(to) } });

      // saved exactly as chosen …
      await waitFor(() =>
        expect(updateShareMock).toHaveBeenCalledWith(shareId, {
          permissions: to,
        }),
      );
      // … and the control shows the chosen label, not a snapped-down one
      await waitFor(() => expect(selectedLabel(select)).toBe(label));

      // reopening the dialog against the freshly stored mask shows the same
      unmount();
      renderFor(isDirectory, [makeShare({ permissions: to })]);
      expect(selectedLabel(accessSelects()[0])).toBe(label);
    }

    it.each([
      ["View only", 19, 1],
      ["Can edit", 1, 3],
      ["Can edit + reshare", 1, 19],
    ])("FILE person share → %s", async (label, from, to) => {
      await pickAndAssertRoundTrip(
        false,
        from as number,
        to as number,
        label as string,
        makePersonShare,
        21,
      );
    });

    it.each([
      ["View only", 19, 1],
      ["Can edit", 1, 3],
      ["Can edit + reshare", 1, 19],
    ])("FILE link share → %s", async (label, from, to) => {
      await pickAndAssertRoundTrip(
        false,
        from as number,
        to as number,
        label as string,
        makeLinkShare,
        30,
      );
    });

    it.each([
      ["View only", 31, 1],
      ["Can edit", 1, 3],
      ["Full access", 1, 31],
    ])("FOLDER person share → %s", async (label, from, to) => {
      await pickAndAssertRoundTrip(
        true,
        from as number,
        to as number,
        label as string,
        makePersonShare,
        21,
      );
    });

    it.each([
      ["View only", 31, 1],
      ["Can edit", 1, 3],
      ["Full access", 1, 31],
    ])("FOLDER link share → %s", async (label, from, to) => {
      await pickAndAssertRoundTrip(
        true,
        from as number,
        to as number,
        label as string,
        makeLinkShare,
        30,
      );
    });
  });

  describe("WARP-939 snapping survives for non-preset OCS masks", () => {
    it.each([
      [17, "View only"], // READ|SHARE — view-level editing, no update bit
      [19, "Can edit + reshare"], // READ|UPDATE|SHARE — now has its own level
      [31, "Can edit + reshare"], // shouldn't exist on a file; degrade sanely
      [3, "Can edit"],
      [1, "View only"],
      [0, "View only"], // never leave the control unselected
    ])("FILE mask %i snaps to %s", (mask, label) => {
      renderFor(false, [makePersonShare({ permissions: mask as number })]);
      const select = accessSelects()[0];
      expect(select.value).not.toBe("");
      expect(selectedLabel(select)).toBe(label);
    });

    it.each([
      [17, "View only"],
      [19, "Can edit"], // SHARE stays ignored on folders (WARP-939)
      [29, "View only"], // READ|CREATE|DELETE|SHARE — no UPDATE, so not "Can edit"
      [31, "Full access"],
      [0, "View only"],
    ])("FOLDER mask %i snaps to %s", (mask, label) => {
      renderFor(true, [makePersonShare({ permissions: mask as number })]);
      const select = accessSelects()[0];
      expect(select.value).not.toBe("");
      expect(selectedLabel(select)).toBe(label);
    });
  });
});

/**
 * WARP-1543 — the Person tab shares with MULTIPLE recipients in one action.
 *
 * Selection used to be a single nullable string: clicking a second member
 * silently replaced the first, there was no toggle-off, and `handleCreate`
 * issued exactly one createShare. Sharing a file with five people meant
 * repeating the whole flow five times, re-picking after every success.
 *
 * Selection is now a Set, the roster row toggles, and one Share click issues
 * one createShare per selected member at the dialog's single (global for v1)
 * access level. Because the N calls are independent, they settle individually:
 * a 3-of-5 outcome must read as three successes and two named failures, and
 * the three that landed are never rolled back or hidden.
 */
describe("WARP-1543 — multi-recipient person shares", () => {
  const ROSTER: ShareRecipient[] = [
    { shareWith: "romain", displayName: "Romain", email: "romain@example.com" },
    { shareWith: "samantha", displayName: "Samantha", email: null },
    { shareWith: "stefan", displayName: "Stefan", email: null },
    { shareWith: "camille", displayName: "Camille", email: null },
    { shareWith: "jonas", displayName: "Jonas", email: null },
  ];

  /**
   * Resolve every create with a row that names its own recipient, so the
   * existing-shares list can be told apart from the roster: the chip reads
   * "share:romain" while the picker row still reads "Romain".
   */
  function resolvePerRecipient(failFor: string[] = []) {
    let nextId = 100;
    createShareMock.mockImplementation(
      (_path: string, opts: { shareWith?: string }) =>
        failFor.includes(opts.shareWith ?? "")
          ? Promise.reject(new Error("Nextcloud said no"))
          : Promise.resolve(
              makePersonShare({
                id: nextId++,
                shareWith: opts.shareWith ?? null,
                shareWithDisplayName: `share:${opts.shareWith}`,
              }),
            ),
    );
  }

  /** The roster row for a member (not the existing-share chip of the same name). */
  function memberRow(displayName: string): HTMLButtonElement {
    for (const el of screen.getAllByText(displayName)) {
      const btn = el.closest("button");
      if (btn) return btn as HTMLButtonElement;
    }
    throw new Error(`roster row for ${displayName} not found`);
  }

  // WARP-1601 note: the footer action must be matched on the EXACT name
  // "Share", since the "Can edit + reshare" level label also contains it.
  const shareButton = () => screen.getByRole("button", { name: "Share" });

  const shareWithArgs = () =>
    createShareMock.mock.calls.map(([, opts]) => opts.shareWith);

  it("toggles a member off when their selected row is clicked again", async () => {
    renderDialog();
    const romain = await screen.findByText("Romain");

    fireEvent.click(romain);
    expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "true");
    expect(shareButton()).not.toBeDisabled();

    fireEvent.click(romain);
    expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "false");
    expect(shareButton()).toBeDisabled();
  });

  it("keeps the first member selected when a second is picked", async () => {
    renderDialog();
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));

    expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "true");
    expect(memberRow("Samantha")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("one Share click creates one share per selected recipient", async () => {
    resolvePerRecipient();
    renderDialog();
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));
    fireEvent.click(shareButton());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(2));
    expect(shareWithArgs()).toEqual(["romain", "samantha"]);
    for (const [path, opts] of createShareMock.mock.calls) {
      expect(path).toBe("/report.pdf");
      // Access level is GLOBAL to the dialog for v1 — same bits for everyone.
      expect(opts).toMatchObject({ shareType: 0, permissions: 1 });
    }

    // both brand-new shares land in the existing-shares list
    expect(await screen.findByText("share:romain")).toBeInTheDocument();
    expect(screen.getByText("share:samantha")).toBeInTheDocument();
  });

  it("applies the chosen access level to every recipient in the batch", async () => {
    resolvePerRecipient();
    renderDialog(); // a FILE — top level is "Can edit + reshare" (19)
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));
    fireEvent.click(screen.getByRole("button", { name: "Can edit + reshare" }));
    fireEvent.click(shareButton());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(2));
    for (const [, opts] of createShareMock.mock.calls) {
      expect(opts.permissions).toBe(19);
    }
  });

  it("reports a 3-of-5 partial failure by name, keeping the three that landed", async () => {
    fetchRecipientsMock.mockResolvedValue(ROSTER);
    resolvePerRecipient(["samantha", "jonas"]);
    renderDialog();

    await screen.findByText("Romain");
    for (const r of ROSTER) fireEvent.click(screen.getByText(r.displayName));
    fireEvent.click(shareButton());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(5));

    const report = await screen.findByRole("alert");
    expect(report.textContent).toMatch(/3 of 5 people/);
    expect(report.textContent).toMatch(/2 failed/);
    // failures are NAMED, each with its own reason — not swallowed into one line
    expect(report.textContent).toContain("Samantha: Nextcloud said no");
    expect(report.textContent).toContain("Jonas: Nextcloud said no");
    expect(report.textContent).not.toContain("Romain:");

    // the successful shares are neither rolled back nor hidden
    expect(screen.getByText("share:romain")).toBeInTheDocument();
    expect(screen.getByText("share:stefan")).toBeInTheDocument();
    expect(screen.getByText("share:camille")).toBeInTheDocument();

    // only the failures stay ticked, so retrying them is one click
    expect(memberRow("Samantha")).toHaveAttribute("aria-pressed", "true");
    expect(memberRow("Jonas")).toHaveAttribute("aria-pressed", "true");
    expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("says so plainly when every recipient in the batch failed", async () => {
    createShareMock.mockRejectedValue(new Error("Nextcloud said no"));
    renderDialog();
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));
    fireEvent.click(shareButton());

    const report = await screen.findByRole("alert");
    expect(report.textContent).toMatch(/Couldn't share with any of the 2 people/);
    expect(report.textContent).toContain("Romain: Nextcloud said no");
    expect(report.textContent).toContain("Samantha: Nextcloud said no");
    // nothing succeeded, so nothing is deselected
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("confirms a fully successful batch and clears the picker", async () => {
    resolvePerRecipient();
    renderDialog();
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));
    fireEvent.click(shareButton());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(2));
    const done = await screen.findByRole("status");
    expect(done.textContent).toMatch(/Shared with 2 people/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "false");
    expect(memberRow("Samantha")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
    expect(shareButton()).toBeDisabled();
  });

  it("notifies the page once for the whole batch, not once per recipient", async () => {
    resolvePerRecipient();
    const onChange = vi.fn();
    renderDialog({ onChange });
    fireEvent.click(await screen.findByText("Romain"));
    fireEvent.click(screen.getByText("Samantha"));
    fireEvent.click(shareButton());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  describe("a single recipient behaves exactly as before", () => {
    it("issues one create, shows no batch summary, and clears the picker", async () => {
      renderDialog();
      fireEvent.click(await screen.findByText("Romain"));
      fireEvent.click(shareButton());

      await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(1));
      expect(createShareMock.mock.calls[0][1]).toMatchObject({
        shareType: 0,
        shareWith: "romain",
      });
      // no "1 of 1" ceremony for a single target
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await waitFor(() =>
        expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "false"),
      );
      expect(shareButton()).toBeDisabled();
    });

    it("renders a lone failure as the bare message, with the pick preserved", async () => {
      createShareMock.mockRejectedValue(new Error("Nextcloud said no"));
      renderDialog();
      fireEvent.click(await screen.findByText("Romain"));
      fireEvent.click(shareButton());

      const report = await screen.findByRole("alert");
      expect(report.textContent).toBe("Nextcloud said no");
      expect(report.textContent).not.toMatch(/of 1/);
      expect(memberRow("Romain")).toHaveAttribute("aria-pressed", "true");
    });
  });
});
