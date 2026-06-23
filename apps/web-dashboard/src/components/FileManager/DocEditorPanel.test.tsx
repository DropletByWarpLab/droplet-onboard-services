/**
 * WARP-882 / WS-4 — DocEditorPanel.
 *
 * Droplet-chrome iframe that hosts the OnlyOffice editor, fed by the
 * editor-session payload. Covers the state machine the design contract requires:
 *   - loading  — while the session mints
 *   - ready    — iframe with editorUrl; "edit" header
 *   - read-only — server returned mode=view → a "View only" badge, no edit chrome
 *   - unavailable — engine 503 → calm "editing unavailable" copy, not a raw error
 *   - error    — any other failure → retry affordance
 * The api client is mocked; nothing loads a real engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { FileEntryInfo, DocEditorSession } from "@/lib/types";

const getEditorSessionMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getEditorSession: (path: string) => getEditorSessionMock(path),
}));

import { DocEditorPanel } from "./DocEditorPanel";

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "report.docx",
    path: "/Documents/report.docx",
    isDirectory: false,
    size: 12345,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    modifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

function editSession(overrides: Partial<DocEditorSession> = {}): DocEditorSession {
  return {
    editorUrl: "https://droplet-ai.local/index.php/apps/onlyoffice/42?mode=edit",
    accessToken: "signed.jwt.token",
    accessTokenTtl: 1800,
    ncFileId: 42,
    mode: "edit",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DocEditorPanel", () => {
  it("shows a loading state while the session mints", async () => {
    let resolve!: (v: DocEditorSession) => void;
    getEditorSessionMock.mockReturnValue(new Promise<DocEditorSession>((r) => (resolve = r)));
    render(<DocEditorPanel file={makeFile()} onClose={vi.fn()} />);
    expect(screen.getByText(/preparing|loading|opening/i)).toBeInTheDocument();
    resolve(editSession());
    await waitFor(() => expect(screen.queryByTitle(/editor/i)).toBeInTheDocument());
  });

  it("renders the editor iframe with the session editorUrl when ready", async () => {
    getEditorSessionMock.mockResolvedValue(editSession());
    render(<DocEditorPanel file={makeFile()} onClose={vi.fn()} />);
    const frame = await screen.findByTitle(/editor/i);
    expect(frame).toHaveAttribute(
      "src",
      "https://droplet-ai.local/index.php/apps/onlyoffice/42?mode=edit",
    );
  });

  it("shows a read-only badge when the server returns mode=view", async () => {
    getEditorSessionMock.mockResolvedValue(
      editSession({ mode: "view", editorUrl: "https://x/onlyoffice/42?mode=view" }),
    );
    render(<DocEditorPanel file={makeFile()} onClose={vi.fn()} />);
    await screen.findByTitle(/editor/i);
    expect(screen.getByText(/view only|read[\s-]?only/i)).toBeInTheDocument();
  });

  it("shows a calm unavailable state (not a raw error) on a 503/DOCS_UNAVAILABLE", async () => {
    // getEditorSession attaches structured {status, code} props to the thrown
    // error (see api.ts); DocEditorPanel branches on those props, not on the
    // message string, so the mock must carry them to exercise the unavailable
    // path (reviewer finding: don't couple the UI to the exact message format).
    getEditorSessionMock.mockRejectedValue(
      Object.assign(new Error("editor session failed: 503 (DOCS_UNAVAILABLE)"), {
        status: 503,
        code: "DOCS_UNAVAILABLE",
      }),
    );
    render(<DocEditorPanel file={makeFile()} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/unavailable|can.t be edited right now|not available/i)).toBeInTheDocument(),
    );
    // No iframe in the unavailable state.
    expect(screen.queryByTitle(/editor/i)).not.toBeInTheDocument();
  });

  it("offers a retry on a generic failure", async () => {
    getEditorSessionMock.mockRejectedValueOnce(new Error("editor session failed: 500"));
    render(<DocEditorPanel file={makeFile()} onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    getEditorSessionMock.mockResolvedValueOnce(editSession());
    fireEvent.click(retry);
    expect(await screen.findByTitle(/editor/i)).toBeInTheDocument();
  });

  it("calls onClose when the close control is activated", async () => {
    getEditorSessionMock.mockResolvedValue(editSession());
    const onClose = vi.fn();
    render(<DocEditorPanel file={makeFile()} onClose={onClose} />);
    await screen.findByTitle(/editor/i);
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    getEditorSessionMock.mockResolvedValue(editSession());
    const onClose = vi.fn();
    render(<DocEditorPanel file={makeFile()} onClose={onClose} />);
    await screen.findByTitle(/editor/i);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
