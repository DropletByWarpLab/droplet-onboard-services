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

import { createShare, fetchShareRecipients } from "@/lib/api";
import { ShareDialog } from "./ShareDialog";

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

beforeEach(() => {
  vi.clearAllMocks();
  fetchRecipientsMock.mockResolvedValue(RECIPIENTS);
  createShareMock.mockResolvedValue(makePersonShare());
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
  it("defaults to Person mode and loads the household roster", async () => {
    renderDialog();
    expect(fetchRecipientsMock).toHaveBeenCalled();
    // Roster members surface once loaded.
    expect(await screen.findByText("Romain")).toBeInTheDocument();
    expect(screen.getByText("Samantha")).toBeInTheDocument();
  });

  it("Create in Person mode sends { shareType:0, shareWith, permissions }", async () => {
    renderDialog();
    // pick Romain from the roster
    const romain = await screen.findByText("Romain");
    fireEvent.click(romain);

    const createBtn = screen.getByRole("button", { name: /share|create/i });
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

  it("shows a friendly empty state when there are no other household members", async () => {
    fetchRecipientsMock.mockResolvedValue([]);
    renderDialog();
    expect(
      await screen.findByText(/no other household members yet/i),
    ).toBeInTheDocument();
  });

  it("disables Create in Person mode until a recipient is chosen", async () => {
    renderDialog();
    await screen.findByText("Romain");
    const createBtn = screen.getByRole("button", { name: /share|create/i });
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
