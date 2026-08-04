/**
 * WARP-1714 — the WiFi Settings card must open showing the network it's about
 * to edit.
 *
 * Both fields used to start as `useState("")` and never hydrate, so the card
 * couldn't tell you your own SSID and the password you'd set visibly "went
 * away" on every reload. These tests pin the prefill, the masked-but-revealable
 * password, and the two ways prefill could go wrong: clobbering an edit the
 * user is halfway through, and pinning the form after a save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WifiSettingsForm } from "../WifiSettingsForm";

vi.mock("@/lib/api", () => ({
  setWifiSsid: vi.fn().mockResolvedValue({ status: "ok" }),
  setWifiPassword: vi.fn().mockResolvedValue({ status: "ok" }),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  RouterStatusError: class RouterStatusError extends Error {
    status = 0;
  },
  routerUnreachableNotice: vi.fn().mockReturnValue(false),
}));

const wireless = {
  radio0: {
    interfaces: [
      {
        section: "default_radio0",
        config: {
          mode: "ap",
          ssid: "Droplet",
          encryption: "psk2",
          key: "droplethome2026",
          network: ["lan"],
        },
      },
    ],
  },
};

// Anchored: an unanchored /wi-fi password/ also matches the reveal button's
// aria-label ("Show Wi-Fi password").
const ssidField = () => screen.getByLabelText(/^network name/i) as HTMLInputElement;
const passwordField = () => screen.getByLabelText(/^wi-fi password$/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WifiSettingsForm hydration (WARP-1714)", () => {
  it("prefills the live SSID and password", async () => {
    render(<WifiSettingsForm wireless={wireless} />);

    await waitFor(() => expect(ssidField().value).toBe("Droplet"));
    expect(passwordField().value).toBe("droplethome2026");
  });

  it("masks the password until the reveal toggle is pressed", async () => {
    render(<WifiSettingsForm wireless={wireless} />);

    await waitFor(() => expect(passwordField().value).toBe("droplethome2026"));
    expect(passwordField().type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show wi-fi password/i }));
    expect(passwordField().type).toBe("text");
  });

  it("renders empty and editable before the first status poll lands", async () => {
    render(<WifiSettingsForm wireless={undefined} />);
    expect(ssidField().value).toBe("");
    expect(passwordField().value).toBe("");
  });

  it("does not clobber an in-progress edit when the 10s poll re-delivers status", async () => {
    const { rerender } = render(<WifiSettingsForm wireless={wireless} />);
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));

    fireEvent.change(ssidField(), { target: { value: "Studio Fotonia" } });

    // A fresh object identity with identical contents — exactly what SWR hands
    // down on every poll.
    rerender(<WifiSettingsForm wireless={JSON.parse(JSON.stringify(wireless))} />);

    expect(ssidField().value).toBe("Studio Fotonia");
  });

  it("adopts a router-side change that happened before the user touched anything", async () => {
    const { rerender } = render(<WifiSettingsForm wireless={wireless} />);
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));

    const changed = {
      radio0: {
        interfaces: [
          {
            section: "default_radio0",
            config: { mode: "ap", ssid: "Droplet-New", key: "rotated12345", network: ["lan"] },
          },
        ],
      },
    };
    rerender(<WifiSettingsForm wireless={changed} />);

    await waitFor(() => expect(ssidField().value).toBe("Droplet-New"));
    expect(passwordField().value).toBe("rotated12345");
  });

  it("re-syncs to the router after a successful save instead of staying pinned", async () => {
    const { rerender } = render(<WifiSettingsForm wireless={wireless} />);
    await waitFor(() => expect(ssidField().value).toBe("Droplet"));

    fireEvent.change(ssidField(), { target: { value: "Studio Fotonia" } });
    fireEvent.click(screen.getByRole("button", { name: /save wi-fi settings/i }));
    await screen.findByText(/wi-fi updated/i);

    // The router now reports the new name; the form must follow it rather than
    // holding the typed value forever.
    const applied = {
      radio0: {
        interfaces: [
          {
            section: "default_radio0",
            config: {
              mode: "ap",
              ssid: "Studio Fotonia",
              key: "droplethome2026",
              network: ["lan"],
            },
          },
        ],
      },
    };
    rerender(<WifiSettingsForm wireless={applied} />);

    await waitFor(() => expect(ssidField().value).toBe("Studio Fotonia"));
  });
});
