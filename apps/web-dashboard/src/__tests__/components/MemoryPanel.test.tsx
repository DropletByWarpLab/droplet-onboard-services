/**
 * WARP-461 front-end — the Memory panel the /api/memory/facts route
 * header has promised since Phase B4. View / toggle active / delete /
 * add durable memory facts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const mockListMemoryFacts = vi.fn();
const mockCreateMemoryFact = vi.fn();
const mockUpdateMemoryFact = vi.fn();
const mockDeleteMemoryFact = vi.fn();
vi.mock("@/lib/api", () => ({
  listMemoryFacts: (...a: unknown[]) => mockListMemoryFacts(...a),
  createMemoryFact: (...a: unknown[]) => mockCreateMemoryFact(...a),
  updateMemoryFact: (...a: unknown[]) => mockUpdateMemoryFact(...a),
  deleteMemoryFact: (...a: unknown[]) => mockDeleteMemoryFact(...a),
}));

// WARP-845 review fix — the panel filters audience options by the
// caller's role (so the select never offers a 403). Owner sees all four.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "romain", displayName: "Romain", role: "owner" },
    isLoading: false,
  }),
}));

import { MemoryPanel } from "@/components/chat/MemoryPanel";

const FACT = {
  id: "f1",
  category: "Workflow" as const,
  fact: "Prefers recaps under 200 words",
  addedBy: "romain",
  evidenceChatId: null,
  active: true,
  audience: "family" as const,
  addedAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

beforeEach(() => {
  mockListMemoryFacts.mockReset();
  mockCreateMemoryFact.mockReset();
  mockUpdateMemoryFact.mockReset();
  mockDeleteMemoryFact.mockReset();
  mockListMemoryFacts.mockResolvedValue({ facts: [FACT] });
});

describe("MemoryPanel", () => {
  it("loads and lists facts when opened", async () => {
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Prefers recaps under 200 words"),
      ).toBeInTheDocument();
    });
    // Scope to the fact list — the add-row <select> also contains the
    // category names as options.
    expect(within(screen.getByRole("list")).getByText("Workflow")).toBeInTheDocument();
  });

  it("toggles a fact inactive via PATCH", async () => {
    mockUpdateMemoryFact.mockResolvedValueOnce({
      fact: { ...FACT, active: false },
    });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));
    await waitFor(() => screen.getByText("Prefers recaps under 200 words"));

    fireEvent.click(screen.getByRole("switch", { name: /active/i }));
    await waitFor(() => {
      expect(mockUpdateMemoryFact).toHaveBeenCalledWith("f1", {
        active: false,
      });
    });
  });

  it("deletes a fact", async () => {
    mockDeleteMemoryFact.mockResolvedValueOnce(undefined);
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));
    await waitFor(() => screen.getByText("Prefers recaps under 200 words"));

    fireEvent.click(screen.getByRole("button", { name: /forget/i }));
    await waitFor(() => {
      expect(
        screen.queryByText("Prefers recaps under 200 words"),
      ).not.toBeInTheDocument();
    });
    expect(mockDeleteMemoryFact).toHaveBeenCalledWith("f1");
  });

  it("retargets a fact's audience via PATCH (WARP-845)", async () => {
    mockUpdateMemoryFact.mockResolvedValueOnce({
      fact: { ...FACT, audience: "guest" },
    });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));
    await waitFor(() => screen.getByText("Prefers recaps under 200 words"));

    // Two "Audience" labels exist (per-fact + add row) — target the
    // per-fact select by its id.
    fireEvent.change(
      screen.getByLabelText("Audience", { selector: "#audience-f1" }),
      { target: { value: "guest" } },
    );
    await waitFor(() => {
      expect(mockUpdateMemoryFact).toHaveBeenCalledWith("f1", {
        audience: "guest",
      });
    });
  });

  it("adds a fact", async () => {
    mockCreateMemoryFact.mockResolvedValueOnce({
      fact: { ...FACT, id: "f2", category: "Tone", fact: "Be concise" },
    });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));
    await waitFor(() => screen.getByText("Prefers recaps under 200 words"));

    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "Tone" },
    });
    fireEvent.change(screen.getByLabelText(/new fact/i), {
      target: { value: "Be concise" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(screen.getByText("Be concise")).toBeInTheDocument();
    });
    expect(mockCreateMemoryFact).toHaveBeenCalledWith({
      category: "Tone",
      fact: "Be concise",
      audience: "family",
    });
  });

  it("offers the WARP-1120 Business category (D-9) and adds a Business fact", async () => {
    mockCreateMemoryFact.mockResolvedValueOnce({
      fact: {
        ...FACT,
        id: "f3",
        category: "Business",
        fact: "Invoices go out on the 1st",
      },
    });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));
    await waitFor(() => screen.getByText("Prefers recaps under 200 words"));

    const categorySelect = screen.getByLabelText(/category/i);
    expect(
      within(categorySelect as HTMLElement).getByRole("option", {
        name: "Business",
      }),
    ).toBeInTheDocument();

    fireEvent.change(categorySelect, { target: { value: "Business" } });
    fireEvent.change(screen.getByLabelText(/new fact/i), {
      target: { value: "Invoices go out on the 1st" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(screen.getByText("Invoices go out on the 1st")).toBeInTheDocument();
    });
    expect(mockCreateMemoryFact).toHaveBeenCalledWith({
      category: "Business",
      fact: "Invoices go out on the 1st",
      audience: "family",
    });
  });

  it("shows an empty state when no facts exist", async () => {
    mockListMemoryFacts.mockResolvedValue({ facts: [] });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));

    await waitFor(() => {
      expect(screen.getByText(/nothing saved yet/i)).toBeInTheDocument();
    });
  });
});
