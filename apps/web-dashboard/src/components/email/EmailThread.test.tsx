/**
 * WARP-837 — EmailThread (column 2).
 *
 * Message-by-message reader. A draft authored by Droplet shows a "Drafted by
 * Droplet" chip. Sending that draft is the safety-critical path: it MUST be
 * gated by an explicit in-UI confirm step (no send call before confirm), and a
 * server 451 off_lan_blocked MUST render a calm, actionable message — never a
 * crash. `sendDraft` is mocked at the api layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const sendDraftMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, sendDraft: (...a: unknown[]) => sendDraftMock(...a) };
});

import { EmailThread } from "./EmailThread";
import type { ThreadDetail } from "@/lib/types-email";

function thread(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: "t1",
    accountId: "acc-1",
    threadKey: "k1",
    subject: "PO 4912 revised ETA",
    lastSender: "Naomi Rivera",
    snippet: "running behind",
    messageCount: 2,
    triageStatus: "inbox",
    draftedByDroplet: true,
    lastMessageAt: new Date().toISOString(),
    messages: [
      {
        id: "m1",
        threadId: "t1",
        messageId: "<m1@x>",
        fromAddr: "naomi@northwind.co",
        fromName: "Naomi Rivera",
        toAddrs: ["me@home.net"],
        ccAddrs: null,
        subject: "PO 4912 revised ETA",
        bodyText: "We are 2h behind on PO 4912. Revised ETA 13:14 PT.",
        bodyHtml: null,
        receivedAt: new Date().toISOString(),
      },
      {
        id: "m2",
        threadId: "t1",
        messageId: "<m2@x>",
        fromAddr: "me@home.net",
        fromName: "Me",
        toAddrs: ["naomi@northwind.co"],
        ccAddrs: null,
        subject: "Re: PO 4912 revised ETA",
        bodyText: "Thanks for the heads-up. 13:14 works on our side.",
        bodyHtml: null,
        receivedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function baseProps() {
  return {
    thread: thread(),
    // The Droplet-authored draft that can be sent.
    draft: {
      id: "d1",
      accountId: "acc-1",
      threadId: "t1",
      toAddrs: ["naomi@northwind.co"],
      ccAddrs: null,
      bccAddrs: null,
      subject: "Re: PO 4912 revised ETA",
      body: "Thanks Naomi, 13:14 is fine on our side.",
      draftedByDroplet: true,
      status: "draft" as const,
      sentAt: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    isLoading: false,
    error: undefined as Error | undefined,
    canSend: true,
    onSent: vi.fn(),
  };
}

beforeEach(() => {
  sendDraftMock.mockReset();
});

describe("EmailThread", () => {
  it("renders every message body in the thread", () => {
    render(<EmailThread {...baseProps()} />);
    expect(screen.getByText(/2h behind on PO 4912/i)).toBeInTheDocument();
    expect(screen.getByText(/13:14 works on our side/i)).toBeInTheDocument();
  });

  it("renders the thread subject as the heading", () => {
    render(<EmailThread {...baseProps()} />);
    expect(
      screen.getByRole("heading", { name: /PO 4912 revised ETA/i }),
    ).toBeInTheDocument();
  });

  it("shows a 'Drafted by Droplet' chip on the AI draft", () => {
    render(<EmailThread {...baseProps()} />);
    expect(screen.getByText(/drafted by droplet/i)).toBeInTheDocument();
  });

  it("does NOT call sendDraft before the confirm step", () => {
    render(<EmailThread {...baseProps()} />);
    // Clicking the primary "Send" reveals a confirm step; it must not send yet.
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    expect(sendDraftMock).not.toHaveBeenCalled();
    // A confirm control is now present.
    expect(
      screen.getByRole("button", { name: /confirm.*send|send.*now/i }),
    ).toBeInTheDocument();
  });

  it("sends only after the user confirms, then reports success", async () => {
    sendDraftMock.mockResolvedValue({ status: "queued", id: "d1" });
    const props = baseProps();
    render(<EmailThread {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /confirm.*send|send.*now/i }),
    );
    await waitFor(() => expect(sendDraftMock).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
  });

  it("lets the user cancel the confirm step without sending", () => {
    render(<EmailThread {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel|keep editing|not now/i }));
    expect(sendDraftMock).not.toHaveBeenCalled();
    // Back to the un-confirmed state — the primary Send is available again.
    expect(screen.getByRole("button", { name: /^send/i })).toBeInTheDocument();
  });

  it("renders a friendly off-LAN message on a 451, not a crash", async () => {
    sendDraftMock.mockResolvedValue({
      status: "off_lan_blocked",
      channel: "outbound_email",
      message:
        "Sending email leaves your Droplet, and outbound email is currently turned off. An admin can enable it in Settings under the off-LAN allowlist.",
    });
    render(<EmailThread {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /confirm.*send|send.*now/i }),
    );
    // Wait on the off-LAN copy itself. "leaves your Droplet" is ALSO in the
    // confirm step, which stays on screen while the send is in flight, so a
    // wait on that phrase resolves before the 451 result has landed and the
    // next line reads the sending state (CI red on the WARP-2098 branch).
    const notice = await screen.findByText(/off-LAN allowlist/i);
    expect(notice).toHaveTextContent(/leaves your Droplet/i);
  });

  it("surfaces a thrown send error as a calm message", async () => {
    sendDraftMock.mockRejectedValue(new Error("Draft already dispatched"));
    render(<EmailThread {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /confirm.*send|send.*now/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/couldn.t send|could not send/i)).toBeInTheDocument(),
    );
  });

  it("hides the send affordance entirely when the user cannot send (RBAC)", () => {
    render(<EmailThread {...baseProps()} canSend={false} />);
    expect(
      screen.queryByRole("button", { name: /^send/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a neutral placeholder when no thread is selected", () => {
    render(
      <EmailThread
        thread={undefined}
        draft={null}
        isLoading={false}
        error={undefined}
        canSend
        onSent={vi.fn()}
      />,
    );
    expect(screen.getByText(/select a (message|conversation|thread)/i)).toBeInTheDocument();
  });

  it("renders a loading state while the thread is fetching", () => {
    render(
      <EmailThread
        thread={undefined}
        draft={null}
        isLoading
        error={undefined}
        canSend
        onSent={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });
});
