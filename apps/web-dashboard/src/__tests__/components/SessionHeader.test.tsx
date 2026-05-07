/**
 * Visual-layer tests for the per-chat SessionHeader (WARP-205).
 *
 * The header surfaces a contextual "Export brain memory for this chat"
 * action only when at least one attachment in the current session has
 * advanced past `pending` (i.e. is `indexing` or `ready`). It calls
 * `GET /api/files/brain/export?chatId=<id>` and triggers a download.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { SessionHeader } from "@/components/chat/SessionHeader";
import type { ChatAttachment } from "@/lib/types";

function attachment(
  overrides: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    localId: "loc-1",
    itemId: "bmi-1",
    filename: "doc.txt",
    bytes: 100,
    status: "ready",
    ...overrides,
  };
}

describe("SessionHeader", () => {
  beforeEach(() => {
    cleanup();
    authFetchMock.mockReset();
  });

  it("renders nothing when there are no attachments", () => {
    const { container } = render(
      <SessionHeader chatId="chat-A" attachments={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when every attachment is still pending or failed", () => {
    const { container } = render(
      <SessionHeader
        chatId="chat-A"
        attachments={[
          attachment({ status: "pending" }),
          attachment({ status: "failed" }),
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the export action when at least one attachment is indexing or ready", () => {
    render(
      <SessionHeader
        chatId="chat-A"
        attachments={[
          attachment({ status: "pending" }),
          attachment({ status: "indexing", filename: "second.txt" }),
        ]}
      />,
    );
    expect(screen.getByTestId("session-header")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /export brain memory for this chat/i,
      }),
    ).toBeInTheDocument();
    // Counter reflects only the exportable subset.
    expect(screen.getByText(/1 file attached/i)).toBeInTheDocument();
  });

  it("hits /api/files/brain/export?chatId=<id> on click and downloads the zip", async () => {
    const blob = new Blob(["zip-bytes"], { type: "application/zip" });
    authFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => blob,
    });
    // Stub createObjectURL — JSDOM doesn't ship it.
    const createUrl = vi.fn(() => "blob:test-url");
    const revokeUrl = vi.fn();
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createUrl as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeUrl as typeof URL.revokeObjectURL;

    render(
      <SessionHeader
        chatId="chat-XYZ"
        attachments={[attachment({ status: "ready" })]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /export brain memory for this chat/i,
      }),
    );

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith(
        "/api/files/brain/export?chatId=chat-XYZ",
      );
      expect(createUrl).toHaveBeenCalledWith(blob);
      expect(revokeUrl).toHaveBeenCalledWith("blob:test-url");
    });

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  it("surfaces a graceful message when the export endpoint isn't online yet", async () => {
    authFetchMock.mockResolvedValue({ ok: false, status: 404 });
    render(
      <SessionHeader
        chatId="chat-A"
        attachments={[attachment({ status: "ready" })]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /export brain memory for this chat/i,
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("status").textContent,
      ).toMatch(/will be online/i);
    });
  });
});
