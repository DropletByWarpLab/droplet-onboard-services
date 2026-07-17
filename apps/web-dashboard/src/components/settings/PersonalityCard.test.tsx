/**
 * WARP-1119 — Settings → Workspace → "AI personality" card (design brief §6
 * Card 1).
 *
 * The states this pins:
 *   - loads the persona and reflects preset / verbosity / first-names /
 *     custom instructions, with the mono character counter vs the 1200 cap.
 *   - dirty → Save → confirm: Save is disabled until something changes,
 *     PATCHes ONLY the changed fields, toasts `Personality updated`
 *     (verbatim §9), and re-disables.
 *   - failed save keeps the edits on screen (never lose edits) and leaves
 *     Save enabled for a retry.
 *   - the live preview re-renders as controls change (local only) and the
 *     first-names toggle drops the name.
 *   - lesser roles render nothing — Settings is an admin surface (§6.3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchPersona = vi.fn();
const patchPersona = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchPersona: (...a: unknown[]) => fetchPersona(...a),
  patchPersona: (...a: unknown[]) => patchPersona(...a),
}));

let mockRole: string | undefined = "owner";
let mockDisplayName = "Nadia Rowe";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "nadia@brightwater.dental", displayName: mockDisplayName, role: mockRole },
  }),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast }),
}));

import { PersonalityCard } from "./PersonalityCard";

const BASE = {
  preset: "warm_friendly" as const,
  verbosity: "balanced" as const,
  useFirstNames: true,
  customInstructions: "",
  updatedBy: null,
  updatedAt: "2026-07-09T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  mockDisplayName = "Nadia Rowe";
  fetchPersona.mockResolvedValue({ ...BASE });
  patchPersona.mockResolvedValue({ ...BASE });
});

describe("PersonalityCard", () => {
  it("loads and reflects the stored persona", async () => {
    fetchPersona.mockResolvedValueOnce({
      ...BASE,
      preset: "founder",
      verbosity: "detailed",
      useFirstNames: false,
      customInstructions: "Numbers first.",
    });
    render(<PersonalityCard />);

    await waitFor(() => expect(fetchPersona).toHaveBeenCalled());
    expect(
      await screen.findByRole("radio", { name: /founder-y/i }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Detailed" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("switch", { name: /use first names/i }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText(/custom instructions/i)).toHaveValue(
      "Numbers first.",
    );
    // Mono counter against the 1200 cap ("Numbers first." = 14 chars).
    expect(screen.getByText("14/1200")).toBeInTheDocument();
    // §9 sub-line, verbatim.
    expect(
      screen.getByText(
        "How Droplet talks — on this dashboard and on voice. It never changes what stays private.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Save disabled until dirty, then PATCHes only the changed fields and toasts", async () => {
    patchPersona.mockResolvedValueOnce({ ...BASE, preset: "direct_technical" });
    render(<PersonalityCard />);

    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /direct & technical/i }));
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(patchPersona).toHaveBeenCalledTimes(1));
    // Only the changed field rides the PATCH (route requires ≥1 field).
    expect(patchPersona).toHaveBeenCalledWith({ preset: "direct_technical" });
    expect(toast).toHaveBeenCalledWith("Personality updated", "success");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
  });

  it("keeps the edits and Save enabled when the save fails", async () => {
    patchPersona.mockRejectedValueOnce(new Error("Failed to save personality settings: 500"));
    render(<PersonalityCard />);

    const field = await screen.findByLabelText(/custom instructions/i);
    fireEvent.change(field, { target: { value: "Always give the numbers first." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Never lose edits — the failed state keeps the text and the button live.
    expect(
      await screen.findByText(
        "That didn’t save — your answers are still here. Try again.",
      ),
    ).toBeInTheDocument();
    expect(field).toHaveValue("Always give the numbers first.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("preserves edits typed while a save is in flight (never lose edits)", async () => {
    // Hold the PATCH open so we can type more into the field mid-flight.
    let resolvePatch: ((v: typeof BASE) => void) | undefined;
    patchPersona.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolvePatch = res;
        }),
    );
    render(<PersonalityCard />);

    const field = await screen.findByLabelText(/custom instructions/i);
    // Edit "A extended thought" and Save.
    fireEvent.change(field, { target: { value: "A extended thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchPersona).toHaveBeenCalledTimes(1));
    expect(patchPersona).toHaveBeenCalledWith({
      customInstructions: "A extended thought",
    });

    // Keep typing WHILE the PATCH is still pending.
    fireEvent.change(field, {
      target: { value: "A extended thought and more" },
    });

    // Server acknowledges the SUBMITTED value (the older text).
    await act(async () => {
      resolvePatch?.({ ...BASE, customInstructions: "A extended thought" });
    });

    // The in-flight edits survive — applyServerState must not clobber the
    // textarea back to the acknowledged (older) value.
    await waitFor(() =>
      expect(field).toHaveValue("A extended thought and more"),
    );
    // And the card is dirty again — the newer edit differs from the freshly
    // saved baseline, so Save re-enables for a follow-up write.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });

  it("re-renders the live preview as controls change, and the first-names toggle drops the name", async () => {
    render(<PersonalityCard />);

    // warm_friendly · balanced · first names on, owner "Nadia Rowe" → Nadia.
    // (The identical §9 string also sits inside the warm preset tile, so we
    // assert on the live-preview capsule specifically.)
    const preview = await screen.findByTestId("persona-live-preview");
    expect(preview).toHaveTextContent(
      "Good morning, Nadia. Three things could use a look today — want the quick version?",
    );

    fireEvent.click(screen.getByRole("switch", { name: /use first names/i }));
    expect(preview).toHaveTextContent(
      "Good morning. Three things could use a look today — want the quick version?",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Concise" }));
    expect(preview).toHaveTextContent(
      "Good morning. Three things could use a look today.",
    );
  });

  it("shows the write safety chip in the footer (§10)", async () => {
    render(<PersonalityCard />);
    expect(await screen.findByText(/confirm to apply/i)).toBeInTheDocument();
  });

  it("renders nothing for a family-role viewer", async () => {
    mockRole = "family";
    const { container } = render(<PersonalityCard />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchPersona).not.toHaveBeenCalled();
  });

  // WARP-1344 — indigo shell conversion. The card renders the shell idiom
  // (.card surface, shell Toggle) instead of the retired dp-* / green-toggle
  // language.
  it("renders the indigo shell card, not the retired dp-card (WARP-1344)", async () => {
    const { container } = render(<PersonalityCard />);
    await screen.findByRole("button", { name: "Save" });
    expect(container.querySelector(".dp-card")).toBeNull();
    expect(container.querySelector(".card")).not.toBeNull();
  });

  it("renders the first-names switch as the shell Toggle (brand accent), not the legacy green ToggleSwitch (WARP-1344)", async () => {
    render(<PersonalityCard />);
    const sw = await screen.findByRole("switch", { name: /use first names/i });
    // Shell Toggle = .sw with .on when checked (ON color = var(--brand));
    // the legacy smart-home ToggleSwitch painted bg-system-green when on.
    expect(sw.className).not.toMatch(/bg-system-green/);
    expect(sw).toHaveClass("sw");
    expect(sw).toHaveClass("on");
  });

  it("renders the group header via the shell Sect pattern — sentence case, no uppercase eyebrow (WARP-1344)", async () => {
    render(<PersonalityCard />);
    const heading = await screen.findByRole("heading", { name: "Workspace" });
    expect(heading.className).not.toMatch(/uppercase/);
    expect(heading.closest(".sect")).not.toBeNull();
  });
});
