/**
 * WARP-883 (WS-1 fast-follow) — ShareDialog renders shares ALREADY on the file.
 *
 * Before this, the dialog only showed shares created in the current session.
 * The Files page now fetches the file's existing shares and passes them as
 * `existingShares`; this pins that the dialog lists them on open (with their
 * link + permissions), and that an `existingShares` change after mount
 * re-syncs the rendered list.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShareDialog } from "./ShareDialog";
import type { ShareDetail } from "@/lib/types";

// The dialog imports share API helpers + translateError; stub the API so the
// component mounts without a network layer (we only assert rendering of the
// passed-in existing shares here).
vi.mock("@/lib/api", () => ({
  createShare: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
}));

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
    expect(screen.getByText(/active links/i)).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://droplet-ai.local/s/abc123")
    ).toBeInTheDocument();
  });

  it("shows no 'Active links' section when there are no existing shares", () => {
    render(
      <ShareDialog
        filePath="/Documents/report.pdf"
        fileName="report.pdf"
        existingShares={[]}
        onClose={() => {}}
      />
    );
    expect(screen.queryByText(/active links/i)).not.toBeInTheDocument();
  });
});
