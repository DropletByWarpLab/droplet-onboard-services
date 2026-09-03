/**
 * WARP-2667 — the business profile card belongs to the Settings → Workspace
 * group, next to the AI personality card (design brief §6: "Two new cards in
 * Settings → Workspace group, in this order after the existing Workspace
 * card" — Card 1 AI personality, Card 2 Business profile).
 *
 * It shipped ~325 lines further down the page instead, between the Anthropic/
 * OpenAI/Gemini key forms and the locations card. `<Sect>` renders a real
 * <h2> and nothing between "AI providers" and the card introduced another
 * one, so the nearest heading above the business profile — the only cue a
 * reader gets — said "AI providers". That is how an owner came to report the
 * business walkthrough as living on "the llm page".
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

vi.mock("@/lib/api", () => ({
  listProviderKeys: (...a: any[]) => listProviderKeysMock(...a),
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

describe("Settings — business profile placement (WARP-2667)", () => {
  it("renders the business profile card inside the Workspace section", async () => {
    render(<SettingsPage />);
    const card = await screen.findByTestId("business-profile-card");

    const section = card.closest("section");
    expect(section).not.toBeNull();
    expect(section!.querySelector("h2")).toHaveTextContent("Workspace");
  });

  it("orders it after the AI personality card, per design brief §6", async () => {
    render(<SettingsPage />);
    const card = await screen.findByTestId("business-profile-card");
    const personality = screen.getByText("AI personality");

    // Node.compareDocumentPosition: FOLLOWING (4) means the card comes after
    // the personality card's heading in document order.
    expect(
      personality.compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not sit under the AI providers heading", async () => {
    render(<SettingsPage />);
    const card = await screen.findByTestId("business-profile-card");
    await waitFor(() =>
      expect(screen.getByTestId("provider-key-gemini")).toBeInTheDocument(),
    );

    const headings = Array.from(document.querySelectorAll("h2"));
    const aiProviders = headings.find((h) => h.textContent === "AI providers");
    expect(aiProviders).toBeDefined();

    // The nearest <h2> above the card is the one a reader attributes it to.
    const above = headings.filter(
      (h) =>
        h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(above.at(-1)).toHaveTextContent("Workspace");
    expect(above).not.toContain(aiProviders);
  });
});
