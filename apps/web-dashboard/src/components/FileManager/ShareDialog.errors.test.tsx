/**
 * WARP-1148/1149 — ShareDialog submit-path error mapping.
 *
 * The 2026-07-08 field bug: creating a public link (Can edit + expiration +
 * password + note) failed and the dialog showed the file-LOADING copy
 * ("We couldn't load those files right now. Try again in a moment.") because
 * every share failure translated through the "files" domain. These tests use
 * the REAL translator (unlike ShareDialog.test.tsx, which stubs it) and pin:
 *
 *   - a failed create NEVER renders the file-loading string;
 *   - unknown failures get the share-specific fallback;
 *   - a module-gated 404 ({"error":"module_disabled"}) surfaces honestly;
 *   - Nextcloud's deterministic password-policy rejection surfaces as
 *     actionable password copy, not "try again".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  createShare: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
  fetchShareRecipients: vi.fn(),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { createShare, fetchShareRecipients } from "@/lib/api";
import { ShareDialog } from "./ShareDialog";

const FILE_LOADING_COPY =
  "We couldn't load those files right now. Try again in a moment.";

const createShareMock = createShare as unknown as ReturnType<typeof vi.fn>;
const fetchRecipientsMock =
  fetchShareRecipients as unknown as ReturnType<typeof vi.fn>;

/** Mirror of api.ts ShareRequestError's shape (the api module is mocked, so
 *  build the same code/status-carrying Error the real helpers throw). */
function shareRequestError(message: string, status: number, code?: string): Error {
  const err = new Error(message) as Error & { status: number; code?: string };
  err.status = status;
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchRecipientsMock.mockResolvedValue([]);
});

async function createLinkAndWaitForError(): Promise<HTMLElement> {
  render(
    <ShareDialog
      filePath="/welcome-to-droplet.md"
      fileName="welcome-to-droplet.md"
      existingShares={[]}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  await waitFor(() => expect(createShareMock).toHaveBeenCalled());
  // The error box renders inside the dialog body once the create settles.
  // WARP-1066: the indigo conversion recolors this box with the branch's
  // canonical inline destructive tint (`#ef4444` / `rgba(239,68,68,.1)`)
  // instead of the old `text-system-red` utility class — select on the
  // structural classes that survive the recolor.
  return waitFor(() => {
    const el = document.querySelector("div.p-2.type-footnote");
    if (!el) throw new Error("error box not rendered yet");
    return el as HTMLElement;
  });
}

describe("WARP-1148 — a failed link create never shows the file-loading copy", () => {
  it("unknown failure → share-specific fallback, not the files fallback", async () => {
    createShareMock.mockRejectedValue(new Error("boom"));
    const errorBox = await createLinkAndWaitForError();
    expect(errorBox.textContent).not.toBe(FILE_LOADING_COPY);
    expect(errorBox.textContent).not.toMatch(/load those files/i);
    expect(errorBox.textContent).toMatch(/share link/i);
    // The raw internal message never reaches the screen.
    expect(errorBox.textContent).not.toContain("boom");
  });

  it("module-gated 404 (module_disabled) surfaces honestly as sharing-off copy", async () => {
    // What a box running the module-toggles gate answers when the Files
    // module is off: 404 {"error":"module_disabled","module":"files"}.
    createShareMock.mockRejectedValue(
      shareRequestError("module_disabled", 404, "module_disabled"),
    );
    const errorBox = await createLinkAndWaitForError();
    expect(errorBox.textContent).not.toMatch(/load those files/i);
    expect(errorBox.textContent).toMatch(/turned off|isn't enabled|disabled/i);
    expect(errorBox.textContent).toMatch(/owner or admin/i);
    expect(errorBox.textContent).not.toContain("module_disabled");
  });

  it("Nextcloud password-policy rejection surfaces as password copy, not retry advice", async () => {
    // Orchestrator surfaces the OCS message verbatim with the OCS status:
    // POST /api/files/share → 400 { error: "OCS share create: …" }.
    createShareMock.mockRejectedValue(
      shareRequestError(
        "OCS share create: Password is present in compromised password list. (400)",
        400,
        "OCS share create: Password is present in compromised password list. (400)",
      ),
    );
    const errorBox = await createLinkAndWaitForError();
    expect(errorBox.textContent).not.toMatch(/load those files/i);
    expect(errorBox.textContent).toMatch(/password/i);
    expect(errorBox.textContent).not.toContain("OCS");
  });
});
