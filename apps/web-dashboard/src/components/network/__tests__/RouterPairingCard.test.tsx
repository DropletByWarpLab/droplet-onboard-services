/**
 * RouterPairingCard (ADR-071 slice B).
 *
 * Pins the three states and what each one is allowed to offer:
 *   PAIR      AUTH + open window -> "ready to pair", Pair (confirms first) / Not now
 *   ELSEWHERE first 16 hex of the other box + the button instruction, NO action
 *   RETRY     "Paired, but the password could not be saved ..." + Retry
 * plus the degradations: routing without a pairing surface renders nothing, and a
 * non-owner/admin never gets a write button.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const fetchRouterPairing = vi.fn();
const pairRouter = vi.fn();
const persistRouterPairing = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchRouterPairing: (...a: unknown[]) => fetchRouterPairing(...a),
  pairRouter: (...a: unknown[]) => pairRouter(...a),
  persistRouterPairing: (...a: unknown[]) => persistRouterPairing(...a),
}));

import { RouterPairingCard } from "../RouterPairingCard";
import type { RouterPairingView } from "@/lib/api";

const BOX = "0123456789abcdef" + "f".repeat(48);

const view = (over: Partial<RouterPairingView> = {}): RouterPairingView => ({
  available: true,
  state: "open",
  windowEndsAt: "2026-10-07T00:00:00Z",
  pairedBox: null,
  pairedElsewhere: false,
  pendingPersist: false,
  routerErrorCode: "AUTH",
  host: "192.168.9.1",
  model: "RB5009",
  ...over,
});

function renderCard(code: Parameters<typeof RouterPairingCard>[0]["routerErrorCode"], onChanged = vi.fn()) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RouterPairingCard routerErrorCode={code} onChanged={onChanged} />
    </SWRConfig>,
  );
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: { role: "owner" } });
});

describe("PAIR state", () => {
  it("offers Pair / Not now with the ADR copy when AUTH + window open", async () => {
    fetchRouterPairing.mockResolvedValue(view());
    renderCard("AUTH");
    expect(await screen.findByText(/Router RB5009 at 192\.168\.9\.1 is ready to pair\./)).toBeTruthy();
    expect(screen.getByText(/gives this Droplet control of the router/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("Pair asks for confirmation first and does not write until confirmed", async () => {
    fetchRouterPairing.mockResolvedValue(view());
    pairRouter.mockResolvedValue({ ok: true, persisted: true, host: "192.168.9.1" });
    const onChanged = renderCard("AUTH");
    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Pair this router?")).toBeTruthy();
    expect(pairRouter).not.toHaveBeenCalled();

    const confirm = screen.getAllByRole("button", { name: "Pair" }).find((b) => b.closest('[role="dialog"]'))!;
    fireEvent.click(confirm);
    await waitFor(() => expect(pairRouter).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a refused claim keeps the dialog open and shows the reason", async () => {
    fetchRouterPairing.mockResolvedValue(view());
    pairRouter.mockResolvedValue({
      ok: false,
      persisted: false,
      code: "PAIR_WINDOW_CLOSED",
      error: "The router is not accepting a pairing right now. Press the router's button, then try again.",
    });
    renderCard("AUTH");
    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));
    const confirm = (await screen.findAllByRole("button", { name: "Pair" })).find((b) => b.closest('[role="dialog"]'))!;
    fireEvent.click(confirm);
    expect(await screen.findByText(/not accepting a pairing right now/i)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Not now hides the offer without writing", async () => {
    fetchRouterPairing.mockResolvedValue(view());
    renderCard("AUTH");
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByText(/is ready to pair/)).toBeNull());
    expect(pairRouter).not.toHaveBeenCalled();
  });

  it("claimed but not saved flips the card to the Retry state", async () => {
    fetchRouterPairing.mockResolvedValue(view());
    pairRouter.mockResolvedValue({ ok: true, persisted: false, host: "192.168.9.1" });
    renderCard("AUTH");
    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));
    const confirm = (await screen.findAllByRole("button", { name: "Pair" })).find((b) => b.closest('[role="dialog"]'))!;
    fireEvent.click(confirm);
    expect(await screen.findByText(/Paired, but the password could not be saved — it will be lost on the next restart/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("is not shown when the window is closed, or the error is not AUTH", async () => {
    fetchRouterPairing.mockResolvedValue(view({ state: "closed" }));
    renderCard("AUTH");
    await waitFor(() => expect(fetchRouterPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
  });

  it("an admin can pair; a family member sees the offer text with no write button", async () => {
    useAuthMock.mockReturnValue({ user: { role: "family" } });
    fetchRouterPairing.mockResolvedValue(view());
    renderCard("AUTH");
    expect(await screen.findByText(/is ready to pair/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
    expect(screen.getByText(/An owner or admin can pair it/)).toBeTruthy();
  });
});

describe("ELSEWHERE state", () => {
  it("shows the first 16 hex and the button instruction, with no action", async () => {
    fetchRouterPairing.mockResolvedValue(
      view({ state: "paired", pairedBox: BOX, pairedElsewhere: true, routerErrorCode: "PAIRED_ELSEWHERE" }),
    );
    renderCard("PAIRED_ELSEWHERE");
    const node = await screen.findByTestId("router-pairing-elsewhere");
    expect(node.textContent).toContain("This router is paired to another device");
    expect(node.textContent).toContain("0123456789abcdef…");
    expect(node.textContent).not.toContain(BOX);
    expect(node.textContent).toContain("Press the router's button to re-pair.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("RETRY state", () => {
  it("shows when routing reports a pending persist, and Retry re-runs the save only", async () => {
    fetchRouterPairing.mockResolvedValue(view({ pendingPersist: true, routerErrorCode: null, state: "paired" }));
    persistRouterPairing.mockResolvedValue({ ok: true, persisted: true });
    const onChanged = renderCard(null);
    expect(await screen.findByText(/Paired, but the password could not be saved — it will be lost on the next restart/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(persistRouterPairing).toHaveBeenCalledTimes(1));
    expect(pairRouter).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a failed retry stays on the card and says why", async () => {
    fetchRouterPairing.mockResolvedValue(view({ pendingPersist: true, routerErrorCode: null }));
    persistRouterPairing.mockResolvedValue({ ok: true, persisted: false, error: "bridge not running" });
    renderCard(null);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("bridge not running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a non-admin gets no Retry button", async () => {
    useAuthMock.mockReturnValue({ user: { role: "family" } });
    fetchRouterPairing.mockResolvedValue(view({ pendingPersist: true, routerErrorCode: null }));
    renderCard(null);
    expect(await screen.findByText(/could not be saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("degradation", () => {
  it("renders nothing when routing has no pairing surface", async () => {
    fetchRouterPairing.mockResolvedValue(view({ available: false, state: null }));
    renderCard("AUTH");
    await waitFor(() => expect(fetchRouterPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the pairing read fails", async () => {
    fetchRouterPairing.mockRejectedValue(new Error("404"));
    renderCard("AUTH");
    await waitFor(() => expect(fetchRouterPairing).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
