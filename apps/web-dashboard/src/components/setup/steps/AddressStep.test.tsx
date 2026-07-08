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
const renameBox = vi.fn();
const fetchBoxName = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    checkBoxName: (...a: unknown[]) => checkBoxName(...a),
    setBoxName: (...a: unknown[]) => setBoxName(...a),
    renameBox: (...a: unknown[]) => renameBox(...a),
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
  renameBox.mockResolvedValue({
    ok: true,
    slug: "renamed",
    fqdn: "renamed.droplet-us.com",
    authoritative: true,
  });
  // WARP-1039 — no saved name by default: every pre-existing test runs against
  // the empty-input baseline (the fresh-pick flow).
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

  it("surfaces a Rename hint (not factory-reset) if the fresh POST races an already-named box", async () => {
    // Defense-in-depth: the already-named box is normally caught on mount, but if
    // the fresh-pick POST still hits a box that already holds a name, the
    // orchestrator answers 409 { code: "BOX_NAME_ALREADY_NAMED" }. The step keys
    // its copy off the CODE and points the owner at Rename — NOT "factory reset".
    fetchBoxName.mockResolvedValue({ name: null, fqdn: null });
    setBoxName.mockRejectedValueOnce(
      Object.assign(new Error("Failed to save box name: 409"), {
        code: "BOX_NAME_ALREADY_NAMED",
      }),
    );
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "studio" } });

    await waitFor(() => expect(continueCta()).toBeEnabled());
    fireEvent.click(continueCta());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already holds a secure address/i);
    expect(alert).toHaveTextContent(/rename/i);
    // The old, now-false "factory reset releases it" copy must be gone.
    expect(alert).not.toHaveTextContent(/factory reset/i);
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

describe("AddressStep — already-named box shows the current address + Rename (WARP-1109)", () => {
  // The reveal affordance in the named view ("Rename this address"); distinct
  // from the picker's "Rename" primary CTA.
  const renameCta = () =>
    screen.getByRole("button", { name: /rename this address/i });
  const keepCta = () => screen.getByRole("button", { name: /keep this address/i });

  it("renders the 'your box is named X' state (not the fresh-pick input) when a name is saved", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);

    // The current address is surfaced with its fqdn + a padlock — NEVER as
    // "taken", and NOT as the fresh-pick input.
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("studio.droplet-us.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(/box name/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is taken/i)).not.toBeInTheDocument();
    // The fresh-pick "check it's free" flow is not what's shown.
    expect(checkBoxName).not.toHaveBeenCalled();
    // Rename is offered.
    expect(renameCta()).toBeInTheDocument();
  });

  it("lets the owner Continue (keep the current name) from the already-named state", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );

    // "Keep this address" advances WITHOUT re-claiming (the name is already held).
    fireEvent.click(keepCta());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(setBoxName).not.toHaveBeenCalled();
    expect(renameBox).not.toHaveBeenCalled();
  });

  it("Rename reveals the name picker; Continue there calls renameBox (release→claim) and advances", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );

    // Reveal the picker.
    fireEvent.click(renameCta());
    expect(await screen.findByLabelText(/box name/i)).toBeInTheDocument();

    // Type a NEW name; the ordinary availability check gates the Rename primary.
    fireEvent.change(nameInput(), { target: { value: "renamed" } });
    const renamePrimary = () =>
      screen.getByRole("button", { name: /^rename$/i });
    await waitFor(() => expect(renamePrimary()).toBeEnabled());
    fireEvent.click(renamePrimary());

    // The rename endpoint (release-then-claim) is used, NOT the fresh setBoxName.
    await waitFor(() => expect(renameBox).toHaveBeenCalledWith("renamed"));
    expect(setBoxName).not.toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("shows a taken conflict with suggestions when the NEW rename name is taken", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    renameBox.mockRejectedValueOnce(
      Object.assign(new Error("That name is already taken — pick another."), {
        code: "BOX_NAME_TAKEN",
      }),
    );
    const onComplete = vi.fn();
    render(<AddressStep onComplete={onComplete} onSkip={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );
    fireEvent.click(renameCta());
    fireEvent.change(await screen.findByLabelText(/box name/i), {
      target: { value: "renamed" },
    });
    const renamePrimary = () =>
      screen.getByRole("button", { name: /^rename$/i });
    await waitFor(() => expect(renamePrimary()).toBeEnabled());
    fireEvent.click(renamePrimary());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already taken|pick another/i,
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("can cancel Rename and return to the current-address state", async () => {
    fetchBoxName.mockResolvedValue({
      name: "studio",
      fqdn: "studio.droplet-us.com",
    });
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );

    fireEvent.click(renameCta());
    expect(await screen.findByLabelText(/box name/i)).toBeInTheDocument();

    // Cancel returns to the current-address view; no rename happened.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.getByText(/your box is named/i)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/box name/i)).not.toBeInTheDocument();
    expect(renameBox).not.toHaveBeenCalled();
  });

  it("leaves the fresh-pick input (no already-named view) when no name is saved yet", async () => {
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchBoxName).toHaveBeenCalledTimes(1));
    expect(nameInput()).toHaveValue("");
    expect(screen.queryByText(/your box is named/i)).not.toBeInTheDocument();
  });

  it("falls back to the fresh-pick flow when the GET fails (best-effort)", async () => {
    fetchBoxName.mockRejectedValueOnce(new Error("network down"));
    render(<AddressStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await waitFor(() => expect(fetchBoxName).toHaveBeenCalledTimes(1));
    expect(nameInput()).toHaveValue("");
    expect(continueCta()).toBeDisabled();
    expect(screen.queryByText(/your box is named/i)).not.toBeInTheDocument();
  });
});
