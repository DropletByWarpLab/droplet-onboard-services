/**
 * WARP-1305 — the "Sync your directory instead" panel must not read as a
 * dead affordance.
 *
 * The connectivity-audit pass (TeamStep.sso.test.tsx) removed the inert
 * "Connect SSO" button, but the remaining not-connected card still HEADLINED
 * an action — "Sync your directory instead" — with accent call-to-action
 * styling and nothing to click: no directory-sync setup flow exists anywhere
 * in the product (SSO providers are provisioned out-of-band; the dashboard
 * has no configure surface). QA clicked the panel and filed the dead end.
 *
 * Per the walkthrough-honesty pattern the panel is now an explicitly
 * non-interactive "isn't available yet" note. Validates:
 *
 *   1. No directory configured → the panel says directory sync isn't
 *      available yet (and points at the invite-by-email path); the old
 *      imperative "Sync your directory instead" headline is gone.
 *   2. The panel is genuinely non-interactive: no buttons, no links, no
 *      role/tabindex on the container — nothing that advertises a click.
 *   3. Discovery failure (best-effort) renders the same honest note.
 *   4. A configured directory still renders the truthful "Directory sync
 *      is on" state with the Synced chip — unchanged by this ticket.
 *
 * Same choreography as TeamStep.sso.test.tsx (bare render, mocked useAuth).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const getEnabledSsoProviders = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    postTeamInvite: vi.fn(async (input: { email: string; role: string }) => ({
      email: input.email.toLowerCase(),
      role: input.role,
    })),
    getEnabledSsoProviders: (...a: unknown[]) => getEnabledSsoProviders(...a),
  };
});

import { TeamStep } from "./TeamStep";

/**
 * 🔴 WARP-2775 — resolve the panel only once the SSO probe has SETTLED.
 *
 * `data-testid="directory-sync-panel"` is on ONE container that renders in
 * three states — "Checking whether a directory is connected…", "directory sync
 * isn't available yet", and "Directory sync is on". So `findByTestId` is
 * satisfied by the FIRST render, before `getEnabledSsoProviders` resolves, and
 * every synchronous assertion after it reads the checking frame.
 *
 * That is what went red in `node / web-dashboard`, on the rejection case —
 * `mockRejectedValue` takes an extra hop through the catch, so it is the one
 * that loses the race most often. The other three tests here were the same bug
 * passing by luck of scheduling, and "no buttons in the panel" passing while
 * the panel says "Checking…" is not the assertion it looks like.
 *
 * Note this is NOT a reason to distrust every `findByTestId` in the suite: the
 * pattern is safe wherever the test-id belongs to the target state alone
 * (`knowledge-search-unavailable`, `camera-access-empty`, …), because then
 * waiting for the id IS waiting for the state. It only bites when one id spans
 * the loading state and the settled one, as here.
 */
async function settledPanel(): Promise<HTMLElement> {
  const panel = await screen.findByTestId("directory-sync-panel");
  await waitFor(() => expect(panel.textContent).not.toMatch(/Checking whether/i));
  return panel;
}

describe("TeamStep directory-sync panel is honest when no flow exists (WARP-1305)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says directory sync isn't available yet (no 'Sync your directory instead' affordance)", async () => {
    getEnabledSsoProviders.mockResolvedValue([]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    const panel = await settledPanel();
    expect(panel.textContent).toMatch(
      /directory sync isn(?:'|’)t available yet/i,
    );
    // Points the customer at the path that DOES work.
    expect(panel.textContent).toMatch(/invite people by email below/i);
    // The action-flavored headline is gone.
    expect(
      screen.queryByText(/sync your directory instead/i),
    ).not.toBeInTheDocument();
  });

  it("offers no interactive dead-end inside the panel", async () => {
    getEnabledSsoProviders.mockResolvedValue([]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    const panel = await settledPanel();
    // Nothing clickable, focusable, or link-shaped in the panel.
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(panel).not.toHaveAttribute("role");
    expect(panel).not.toHaveAttribute("tabindex");
    expect(panel).not.toHaveAttribute("onclick");
    // And no cursor-affordance styling on the container.
    expect(panel.className).not.toMatch(/cursor-pointer/);
  });

  it("renders the same honest note when discovery fails (best-effort)", async () => {
    getEnabledSsoProviders.mockRejectedValue(new Error("offline"));
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    const panel = await settledPanel();
    expect(panel.textContent).toMatch(
      /directory sync isn(?:'|’)t available yet/i,
    );
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the truthful 'Directory sync is on' state when a directory IS connected", async () => {
    getEnabledSsoProviders.mockResolvedValue(["google"]);
    render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);

    expect(await screen.findByText(/directory sync is on/i)).toBeInTheDocument();
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    expect(screen.getByText(/google workspace/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn(?:'|’)t available yet/i),
    ).not.toBeInTheDocument();
  });
});
