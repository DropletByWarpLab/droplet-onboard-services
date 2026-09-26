/**
 * WARP-2979 (ADR-059 P4 §8) — Droplet's suggestions above the Areas cards:
 * hidden when empty or below manage; Add it and Not this call routes 24 and
 * 25; a refusal is a translateError toast, never the server's words.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SecurityLinkProposal } from "@/lib/types";

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));

import { LinkSuggestions, SUGGEST_COPY } from "@/components/security/LinkSuggestions";

const NOW = new Date("2026-09-24T12:00:00Z");
const P: SecurityLinkProposal = {
  linkId: "p1",
  zone: { id: "z1", name: "Stock room", kind: "interior" },
  sourceKind: "camera_zone",
  sourceRef: "back_cam/till",
  label: "Back camera",
  confidence: 0.45,
  evidence: null,
  suggestedAt: "2026-09-20T14:14:00.000Z",
};

function renderIt(over: Partial<Parameters<typeof LinkSuggestions>[0]> = {}) {
  const accept = vi.fn().mockResolvedValue({});
  const reject = vi.fn().mockResolvedValue({});
  render(<LinkSuggestions proposals={[P]} canManage tz="Europe/London" now={NOW} accept={accept} reject={reject} {...over} />);
  return { accept, reject };
}

beforeEach(() => h.toast.mockReset());

describe("LinkSuggestions", () => {
  it("a card per suggestion: what it may cover, and when it was suggested", () => {
    renderIt();
    expect(screen.getByText(SUGGEST_COPY.title)).toBeInTheDocument();
    expect(screen.getByText("The 'till' part of Back camera's view may cover Stock room")).toBeInTheDocument();
    expect(screen.getByText("Droplet suggested this on Sep 20.")).toBeInTheDocument();
  });

  it("hidden when there are none, or below manage", () => {
    const { container: a } = render(<LinkSuggestions proposals={[]} canManage tz="UTC" now={NOW} accept={vi.fn()} reject={vi.fn()} />);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = render(<LinkSuggestions proposals={[P]} canManage={false} tz="UTC" now={NOW} accept={vi.fn()} reject={vi.fn()} />);
    expect(b).toBeEmptyDOMElement();
  });

  it("Add it → route 24; Not this → route 25, with the never-again toast", async () => {
    const { accept, reject } = renderIt();
    fireEvent.click(screen.getByRole("button", { name: SUGGEST_COPY.add }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getByRole("button", { name: SUGGEST_COPY.notThis }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("p1"));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("Droplet won't suggest the 'till' part of Back camera's view for Stock room again.", "success"),
    );
  });

  it("a 409 is the Security domain's words, never the server's message", async () => {
    const SECRET = "prisma P2034 on SecurityZoneLink";
    renderIt({ accept: vi.fn().mockRejectedValue(Object.assign(new Error(SECRET), { code: "LINK_NOT_DECIDABLE", status: 409 })) });
    fireEvent.click(screen.getByRole("button", { name: SUGGEST_COPY.add }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("Someone already decided"), "error"));
    expect(h.toast.mock.calls.flat().join(" ")).not.toContain(SECRET);
  });
});
