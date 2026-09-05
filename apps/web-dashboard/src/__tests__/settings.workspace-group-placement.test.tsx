/**
 * WARP-2667 — the Settings → Workspace group and the headless cards that
 * belong to it: AI personality (§6 Card 1), business profile (§6 Card 2),
 * and locations (WARP-1906). "Headless" means a card renders its own
 * `type-headline` but no <Sect>, so it CANNOT own a Settings group — it has
 * to sit inside the section of the card that does, or it inherits whatever
 * heading happens to be above it.
 *
 * Both headless cards had inherited the wrong one.
 *
 * Both shipped ~325 lines further down the page, in the run of cards after
 * `<Sect title="AI providers" />`. `<Sect>` renders a real <h2>, and nothing
 * between that heading and either card introduced another one — so the
 * nearest heading above them, the only cue a reader gets, said "AI
 * providers". That is how an owner came to report the business walkthrough
 * as living on "the llm page".
 *
 * Nothing caught it: no test referenced the component, and `Sect` emits no
 * id, so the Settings page has no anchors and no deep link could contradict
 * the placement either. This file is that missing guard. It pins the grouping
 * — the heading the card actually sits under — not a line number, so it
 * survives reordering inside the group.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchUsersMock = vi.fn();
const listProviderKeysMock = vi.fn();
const fetchBusinessProfileMock = vi.fn();
const fetchPersonaMock = vi.fn();

const fetchWorkspaceLocationsMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
  fetchWorkspaceLocations: (...a: any[]) => fetchWorkspaceLocationsMock(...a),
  createWorkspaceLocation: vi.fn(),
  updateWorkspaceLocation: vi.fn(),
  deleteWorkspaceLocation: vi.fn(),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
  fetchBusinessProfile: (...a: any[]) => fetchBusinessProfileMock(...a),
  patchBusinessProfile: vi.fn(),
  startBusinessOnboarding: vi.fn(),
  fetchPersona: (...a: any[]) => fetchPersonaMock(...a),
  patchPersona: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "owner", displayName: "Nadia Rowe", role: "owner" },
  }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({ device: null, devices: [], health: null, isLoading: false, error: null }),
}));

vi.mock("@/components/ProviderKeyForm", () => ({
  ProviderKeyForm: ({ provider }: { provider: string }) => (
    <div data-testid={`provider-key-${provider}`} />
  ),
}));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

import SettingsPage from "@/app/settings/page";

beforeEach(() => {
  vi.clearAllMocks();
  listProviderKeysMock.mockResolvedValue([]);
  fetchUsersMock.mockResolvedValue({ users: [] });
  fetchPersonaMock.mockResolvedValue({
    preset: "warm_friendly",
    verbosity: "balanced",
    useFirstNames: true,
    customInstructions: "",
    updatedBy: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  // onboardingState is what makes the card render at all, and the GET view
  // returns it to owner/admin ONLY (business-profile.ts readView) — the same
  // audience PersonalityCard gates itself to. That is why the card can be a
  // child of the personality card without ever outliving its heading.
  fetchWorkspaceLocationsMock.mockResolvedValue([
    { id: "l1", building: "HQ", room: "Room Aurora" },
  ]);
  fetchBusinessProfileMock.mockResolvedValue({
    onboardingState: "completed",
    whatWeDo: "Family dentistry",
    customers: "Local families",
    teamShape: "Six people",
    toolsUsed: "Open Dental",
    typicalDay: "Twenty chairs a day",
    goals: "Fewer no-shows",
    lastSource: "onboarding",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
});

/** Every headless card the Workspace group renders, by testid. Add a row
 *  when a new one joins — all four cases below iterate this list. */
const HEADLESS_WORKSPACE_CARDS = [
  ["business profile", "business-profile-card"],
  ["locations", "locations-card"],
] as const;

describe("Settings — Workspace group placement (WARP-2667)", () => {
  it.each(HEADLESS_WORKSPACE_CARDS)(
    "renders the %s card inside the Workspace section",
    async (_name, testId) => {
      render(<SettingsPage />);
      const card = await screen.findByTestId(testId);

      const section = card.closest("section");
      expect(section).not.toBeNull();
      expect(section!.querySelector("h2")).toHaveTextContent("Workspace");
    },
  );

  it.each(HEADLESS_WORKSPACE_CARDS)(
    "orders the %s card after the AI personality card (§6: personality is Card 1)",
    async (_name, testId) => {
      render(<SettingsPage />);
      const card = await screen.findByTestId(testId);
      const personality = screen.getByText("AI personality");

      // compareDocumentPosition FOLLOWING (4): the card comes after the
      // personality card's headline in document order.
      expect(
        personality.compareDocumentPosition(card) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it.each(HEADLESS_WORKSPACE_CARDS)(
    "does not leave the %s card under the AI providers heading",
    async (_name, testId) => {
      render(<SettingsPage />);
      const card = await screen.findByTestId(testId);
      await waitFor(() =>
        expect(screen.getByTestId("provider-key-gemini")).toBeInTheDocument(),
      );

      const headings = Array.from(document.querySelectorAll("h2"));
      const aiProviders = headings.find(
        (h) => h.textContent === "AI providers",
      );
      expect(aiProviders).toBeDefined();

      // The nearest <h2> above the card is the one a reader attributes it to.
      const above = headings.filter(
        (h) =>
          h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(above.at(-1)).toHaveTextContent("Workspace");
      expect(above).not.toContain(aiProviders);
    },
  );

  // Guards the list itself. Enumerated coverage is exactly what failed here:
  // both cards were unreferenced by any test, so nothing noticed where they
  // rendered. Assert from the DOM that the Workspace section contains no
  // card this file has not accounted for — a new headless card added to the
  // group fails here until it is listed, and one moved out fails above.
  it("accounts for every card the Workspace group renders", async () => {
    render(<SettingsPage />);
    await screen.findByTestId(HEADLESS_WORKSPACE_CARDS[0][1]);
    await waitFor(() =>
      expect(
        screen.getByTestId(HEADLESS_WORKSPACE_CARDS[1][1]),
      ).toBeInTheDocument(),
    );

    const workspace = Array.from(document.querySelectorAll("section")).find(
      (el) => el.querySelector("h2")?.textContent === "Workspace",
    );
    expect(workspace).toBeDefined();

    // `-card` only: the section also carries non-card testids of its own
    // (persona-live-preview), which are internals of the personality card and
    // not group members.
    const rendered = Array.from(
      workspace!.querySelectorAll('[data-testid$="-card"]'),
    ).map((el) => el.getAttribute("data-testid"));
    const known = HEADLESS_WORKSPACE_CARDS.map(([, id]) => id);

    expect(rendered.length).toBeGreaterThan(0);
    expect([...rendered].sort()).toEqual([...known].sort());
  });
});
