/**
 * WARP-979 — the reworked "Secured / name your box" step (ported from the
 * handoff's SetSecured). The owner types a name that becomes
 * `<name>.droplet-us.com`; live client-side validation + a debounced
 * availability check gate Continue, and Skip is always allowed.
 *
 * These tests exercise: name entry, validation (invalid + reserved), the
 * availability check, the disabled/enabled Continue, and the persist-on-Continue
 * POST. The client-side validator is the SHARED @droplet/shared-types util, so a
 * bad name reads as invalid without any network round-trip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddressStep } from "./AddressStep";

const checkBoxName = vi.fn();
const setBoxName = vi.fn();
const fetchBoxName = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    checkBoxName: (...a: unknown[]) => checkBoxName(...a),
    setBoxName: (...a: unknown[]) => setBoxName(...a),
    fetchBoxName: (...a: unknown[]) => fetchBoxName(...a),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  checkBoxName.mockResolvedValue({
    available: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    authoritative: false,
  });
  setBoxName.mockResolvedValue({
    ok: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
  });
  // WARP-1039 — no saved name by default: every pre-existing test runs against
  // the empty-input baseline.
  fetchBoxName.mockResolvedValue({ name: null, fqdn: null });
});

const nameInput = () => screen.getByLabelText(/box name/i);
const continueCta = () => screen.getByRole("button", { name: /^continue$/i });

describe("AddressStep — Secured / name your box (WARP-979)", () => {
  it("starts with Continue disabled (no name yet) and shows the .droplet-us.com suffix", () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(continueCta()).toBeDisabled();
    expect(screen.getByText(".droplet-us.com")).toBeInTheDocument();
  });

  it("enables Continue once a valid, available name is entered", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    await waitFor(() => expect(continueCta()).toBeEnabled());
    // The status line reports availability; the fqdn is in a nested <span> so we
    // assert the phrase on the enclosing status region.
    const statusRegion = screen.getByRole("status");
    await waitFor(() =>
      expect(statusRegion).toHaveTextContent(
        /studio\.droplet-us\.com is available/i,
      ),
    );
    expect(checkBoxName).toHaveBeenCalled();
  });

  it("keeps Continue disabled and shows an inline reason for an invalid name (no network call)", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    // Uppercase + space → charset failure, caught client-side by the shared util.
    fireEvent.change(nameInput(), { target: { value: "My Box" } });

    expect(
      await screen.findByText(/lowercase letters, numbers, and hyphens/i),
    ).toBeInTheDocument();
    expect(continueCta()).toBeDisabled();
    expect(checkBoxName).not.toHaveBeenCalled();
  });

  it("keeps Continue disabled and shows the reason when the name is taken", async () => {
    checkBoxName.mockResolvedValue({
      available: false,
      slug: "studio",
      fqdn: "studio.droplet-us.com",
      authoritative: false,
      reason: "reserved",
      message: "That name is reserved — pick another.",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    expect(
      await screen.findByText(/that name is reserved — pick another/i),
    ).toBeInTheDocument();
    expect(continueCta()).toBeDisabled();
  });

  it("POSTs the chosen name and advances on Continue", async () => {
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    await waitFor(() => expect(continueCta()).toBeEnabled());
    fireEvent.click(continueCta());

    await waitFor(() => expect(setBoxName).toHaveBeenCalledWith("studio"));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("surfaces a save error and does NOT advance when the POST fails", async () => {
    setBoxName.mockRejectedValueOnce(new Error("box is busy"));
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    await waitFor(() => expect(continueCta()).toBeEnabled());
    fireEvent.click(continueCta());

    expect(await screen.findByRole("alert")).toHaveTextContent(/box is busy/i);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows the rename-unsupported copy when the box already holds a name (WARP-984)", async () => {
    // The orchestrator answers 409 { code: "BOX_NAME_RENAME_UNSUPPORTED" }; the
    // api client surfaces it as an error carrying that code. The step must key
    // its copy off the CODE (not echo whatever message rode along) and show the
    // honest "already holds an address — factory reset releases it" copy.
    setBoxName.mockRejectedValueOnce(
      Object.assign(new Error("Failed to save box name: 409"), {
        code: "BOX_NAME_RENAME_UNSUPPORTED",
      }),
    );
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    await waitFor(() => expect(continueCta()).toBeEnabled());
    fireEvent.click(continueCta());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already holds a secure address/i,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/factory reset/i);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not let a slow availability response overwrite a newer invalid state (stale-check race)", async () => {
    // The first check resolves LATE (available); by then the owner has typed on
    // into an invalid name. The stale "available" result must be discarded so
    // Continue stays disabled and the invalid message stands.
    let resolveFirst: (v: unknown) => void = () => {};
    checkBoxName.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    // Type a valid name; let the debounce fire so the (pending) check starts.
    fireEvent.change(nameInput(), { target: { value: "studio" } });
    await waitFor(() => expect(checkBoxName).toHaveBeenCalledTimes(1));

    // Owner types on into an invalid name BEFORE the first check resolves.
    fireEvent.change(nameInput(), { target: { value: "studio!" } });
    expect(
      await screen.findByText(/lowercase letters, numbers, and hyphens/i),
    ).toBeInTheDocument();
    expect(continueCta()).toBeDisabled();

    // Now the stale first check resolves as available — it must NOT re-enable
    // Continue or clear the invalid message.
    resolveFirst({
      available: true,
      slug: "studio",
      fqdn: "studio.droplet-us.com",
      authoritative: false,
    });
    // Give React a tick to (not) apply the stale result.
    await new Promise((r) => setTimeout(r, 0));
    expect(continueCta()).toBeDisabled();
    expect(
      screen.getByText(/lowercase letters, numbers, and hyphens/i),
    ).toBeInTheDocument();
  });

  it("allows Skip without choosing a name", () => {
    const onSkip = vi.fn();
    render(<AddressStep onComplete={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("renders the padlock explanation LearnMore card", () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByText(/what the padlock means/i)).toBeInTheDocument();
  });
});

describe("AddressStep — rehydrates the saved name (WARP-1039)", () => {
  it("prefills the saved name on mount, shows the current-address hint, and enables Continue", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => expect(nameInput()).toHaveValue("studio"));
    expect(
      screen.getByText(/this is your current address/i),
    ).toBeInTheDocument();
    // The prefilled name runs through the ordinary debounced availability
    // check, which enables Continue — the owner can keep the name as-is.
    await waitFor(() => expect(continueCta()).toBeEnabled());
    expect(checkBoxName).toHaveBeenCalled();
  });

  it("leaves the input empty (no hint) when no name is saved yet", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchBoxName).toHaveBeenCalledTimes(1));
    expect(nameInput()).toHaveValue("");
    expect(
      screen.queryByText(/this is your current address/i),
    ).not.toBeInTheDocument();
  });

  it("never overwrites a name the owner already typed (slow GET resolves late)", async () => {
    let resolveGet: (v: unknown) => void = () => {};
    fetchBoxName.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.change(nameInput(), { target: { value: "other-name" } });
    resolveGet({ name: "studio", fqdn: "studio.droplet-us.com" });
    // Give React a tick to (not) apply the late prefill.
    await waitFor(() => expect(nameInput()).toHaveValue("other-name"));
    expect(
      screen.queryByText(/this is your current address/i),
    ).not.toBeInTheDocument();
  });

  it("drops the hint once the owner edits away from the saved name", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(nameInput()).toHaveValue("studio"));

    fireEvent.change(nameInput(), { target: { value: "new-name" } });
    expect(
      screen.queryByText(/this is your current address/i),
    ).not.toBeInTheDocument();
  });

  it("associates the current-address hint with the input for screen readers, at AA contrast", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(nameInput()).toHaveValue("studio"));

    // SR channel: the input must reference the hint so a screen-reader user
    // learns the prefilled name is their CURRENT address, not a suggestion.
    const hint = screen.getByText(/this is your current address/i);
    expect(hint).toHaveAttribute("id", "box-name-current-hint");
    expect(nameInput()).toHaveAttribute(
      "aria-describedby",
      "box-name-current-hint",
    );
    // Contrast: secondary label token (≥4.5:1), not the ~1.7:1 tertiary.
    expect(hint.className).toContain("text-label-secondary");
    expect(hint.className).not.toContain("text-label-tertiary");
  });

  it("drops the aria-describedby association when the hint is not shown", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchBoxName).toHaveBeenCalledTimes(1));
    expect(nameInput()).not.toHaveAttribute("aria-describedby");
  });

  it("keeps the empty-input baseline when the GET fails (best-effort rehydration)", async () => {
    fetchBoxName.mockRejectedValueOnce(new Error("network down"));
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchBoxName).toHaveBeenCalledTimes(1));
    expect(nameInput()).toHaveValue("");
    expect(continueCta()).toBeDisabled();
  });
});
