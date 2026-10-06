/**
 * WARP-3433 — /admin/claude-activity ships dark, and dark means ABSENT.
 *
 * It is Warp Lab's own engineering dashboard, not a customer feature. The page
 * decides for itself, through the REAL `useCapabilityState` (mocked one layer
 * below, at `authFetch`), before it asks the box anything about activity:
 *
 *   · the capability probe has not answered → render NOTHING;
 *   · it answers `claudeActivity: false`, or fails (a non-admin's 403, an older
 *     orchestrator) → a plain 404 (`notFound()`, caught here by a stand-in for
 *     Next's boundary), never a card;
 *   · it answers true → the page, and only then the first poll.
 *
 * The nav entry is gated on the same capability; the second block pins that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { SWRConfig } from "swr";

const h = vi.hoisted(() => ({
  capabilities: vi.fn(),
  poll: vi.fn(),
  authFetch: vi.fn(),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: { title?: string; children: ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "owner" }, isLoading: false }),
  authFetch: h.authFetch,
}));
// Next's own `notFound()` throws an error the segment's boundary turns into app/not-found.tsx.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));

import ClaudeActivityPage from "@/app/admin/claude-activity/page";
import { NAV_GROUPS, passesGates, settingsGroups, type NavItem } from "@/components/nav-config";

/** Stands in for the segment's NotFoundBoundary: renders what app/not-found.tsx would. */
class NotFoundBoundary extends Component<{ children: ReactNode }, { notFound: boolean }> {
  state = { notFound: false };
  static getDerivedStateFromError(err: { digest?: string }) {
    if (err?.digest === "NEXT_HTTP_ERROR_FALLBACK;404") return { notFound: true };
    throw err;
  }
  render() {
    return this.state.notFound ? <div data-testid="not-found">Page not found</div> : this.props.children;
  }
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NotFoundBoundary>{children}</NotFoundBoundary>
    </SWRConfig>
  );
}
const renderPage = () => render(<ClaudeActivityPage />, { wrapper: Wrap });

const reply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

beforeEach(() => {
  h.capabilities.mockReset();
  h.poll.mockReset();
  h.authFetch.mockReset();
  h.authFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/api/admin/capabilities")) return h.capabilities();
    if (String(url).includes("/api/admin/claude-activity")) return h.poll();
    throw new Error(`unexpected fetch ${url}`);
  });
  // 304: "nothing new", so the page settles without rendering any widget.
  h.poll.mockResolvedValue(reply(304));
});

const polled = () => h.poll.mock.calls.length;

describe("/admin/claude-activity page: ships dark, absent", () => {
  it("renders nothing, and polls nothing, until the capability probe has answered", async () => {
    h.capabilities.mockReturnValue(new Promise(() => {})); // never answers
    const { container } = renderPage();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("not-found")).toBeNull();
    expect(polled()).toBe(0);
  });

  it("is a plain 404 when claudeActivity is false, and never polls", async () => {
    h.capabilities.mockResolvedValue(reply(200, { claudeActivity: false, ragEval: true }));
    renderPage();
    expect(await screen.findByTestId("not-found")).toBeInTheDocument();
    expect(screen.queryByText("Claude activity")).toBeNull();
    expect(polled()).toBe(0);
  });

  it("is a plain 404 when the probe itself is refused (403), and never polls", async () => {
    h.capabilities.mockResolvedValue(reply(403, { error: "admin required" }));
    renderPage();
    expect(await screen.findByTestId("not-found")).toBeInTheDocument();
    expect(polled()).toBe(0);
  });

  it("renders the page, and only then polls, when claudeActivity is true (lab box)", async () => {
    h.capabilities.mockResolvedValue(reply(200, { claudeActivity: true, ragEval: false }));
    renderPage();
    expect(await screen.findByText("Claude activity")).toBeInTheDocument();
    await waitFor(() => expect(polled()).toBe(1));
    expect(screen.queryByTestId("not-found")).toBeNull();
  });
});

describe("/admin/claude-activity nav entry: absent when the capability is false", () => {
  const flatten = (items: NavItem[]): NavItem[] =>
    items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
  const entry = flatten(NAV_GROUPS.flatMap((g) => g.items)).find((i) => i.href === "/admin/claude-activity")!;
  const caps = (claudeActivity: boolean) => ({ claudeActivity, ragEval: true, medicalConnector: true });
  const allOn = () => true;
  const settingsHrefs = (c: boolean) =>
    settingsGroups("owner", caps(c), allOn).flatMap((g) => g.items.map((i) => i.href));

  it("is gated on the claudeActivity capability", () => {
    expect(entry.requiresCapability).toBe("claudeActivity");
    expect(passesGates(entry, "owner", caps(false), allOn)).toBe(false);
    expect(passesGates(entry, "admin", caps(false), allOn)).toBe(false);
    expect(passesGates(entry, "owner", caps(true), allOn)).toBe(true);
  });

  it("is not listed in Settings when the capability is false", () => {
    expect(settingsHrefs(false)).not.toContain("/admin/claude-activity");
    expect(settingsHrefs(true)).toContain("/admin/claude-activity");
  });
});
