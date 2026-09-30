/**
 * WARP-1683 (UX review pin) — the nav unread badge's a11y markup: the
 * numeral is aria-hidden (an aria-label on a generic <span> is ignored by
 * screen readers) and the adjacent sr-only text carries the meaning.
 * NavBadge is exported from Sidebar.tsx for exactly this pin; the same
 * pattern is pinned for the thread list's pill in
 * src/app/messages/__tests__/ThreadList.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Sidebar.tsx's module graph pulls the auth/nav/hook stack; neutralize the
// hook modules so importing NavBadge stays side-effect free (per-user-gating
// suite precedent — mocks, not renders, carry the heavy chrome).
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: null, logout: vi.fn() }) }));
vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));
vi.mock("@/lib/hooks/useModuleGate", () => ({ useModuleGate: () => () => true }));
vi.mock("@/lib/hooks/useTeamChat", () => ({ useTeamChatUnread: () => 0 }));
vi.mock("@/lib/hooks/useAgentRunsActive", () => ({ useAgentRunsActive: () => ({ count: 0, needsYou: false }) }));

import { NavBadge } from "@/components/Sidebar";

describe("NavBadge — a11y markup pin (WARP-1683)", () => {
  it("hides at zero", () => {
    const { container } = render(<NavBadge count={0} />);
    expect(container.textContent).toBe("");
  });

  it("aria-hidden numeral + sr-only '{count} unread'; caps at 99+", () => {
    render(<NavBadge count={5} />);
    const numeral = screen.getByText("5");
    expect(numeral.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("5 unread").className).toContain("sr-only");

    render(<NavBadge count={120} />);
    expect(screen.getByText("99+").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("120 unread").className).toContain("sr-only");
  });
});

describe("NavBadge — background runs (WARP-3303)", () => {
  it("turns amber and says what it counts when a run needs an OK", () => {
    render(<NavBadge count={2} warn label={(n) => `${n} background tasks going, one needs your OK`} />);
    const numeral = screen.getByText("2");
    expect(numeral.getAttribute("data-warn")).toBe("true");
    expect(numeral.className).toContain("text-system-orange");
    expect(screen.getByText("2 background tasks going, one needs your OK").className).toContain("sr-only");
  });

  it("keeps the accent tone when nothing needs a decision", () => {
    render(<NavBadge count={1} />);
    expect(screen.getByText("1").getAttribute("data-warn")).toBeNull();
    expect(screen.getByText("1").className).toContain("text-accent");
  });
});
