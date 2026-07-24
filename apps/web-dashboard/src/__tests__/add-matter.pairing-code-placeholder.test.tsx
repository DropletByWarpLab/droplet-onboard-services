/**
 * WARP-1504 — the pairing-code example must read as a placeholder, not a
 * pre-filled value.
 *
 * Reported: "3497-0112-3320" rendered in full-contrast text, indistinguishable
 * from a real entered code, so a customer could believe the field was already
 * filled in and press Commission without ever typing their device's code.
 *
 * Root cause: `/devices/add-matter` never wraps its content in the
 * `.droplet-shell` token scope that every sibling dashboard page (see
 * `/devices` — `ShellPage`) gets for free. `--text-muted` (the dimmed
 * placeholder token) is only DEFINED inside that scope
 * (components/shell/indigo-tokens.css); outside of it `var(--text-muted)`
 * resolves to nothing, which for the inherited `color` property computes to
 * the ambient (full-contrast) text color — so the placeholder painted in the
 * exact same color as a real value would. The component itself was already
 * correct (empty `useState`, `placeholder` attribute, `placeholder:text-…`
 * class) — the page around it just never loaded the token scope that class
 * depends on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AddMatterDevicePage from "@/app/devices/add-matter/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: class {
    reset = vi.fn();
    decodeFromVideoElement = vi.fn();
  },
}));
vi.mock("@zxing/library", () => ({
  NotFoundException: class extends Error {},
}));

const commissionSpy = vi.fn();
const capabilitiesSpy = vi.fn();
vi.mock("@/lib/api", () => ({
  commissionMatterDevice: (code: string) => commissionSpy(code),
  fetchMatterCapabilities: () => capabilitiesSpy(),
}));

describe("AddMatterDevicePage — pairing-code placeholder (WARP-1504)", () => {
  beforeEach(() => {
    commissionSpy.mockReset();
    capabilitiesSpy.mockReset();
    capabilitiesSpy.mockResolvedValue({
      bleCommissioning: true,
      wifiProvisioning: true,
      apSsid: "Droplet",
    });
  });

  it("renders the pairing-code field empty, with the example code only in the placeholder attribute", async () => {
    render(<AddMatterDevicePage />);
    const input = (await screen.findByLabelText(
      /enter the pairing code/i,
    )) as HTMLInputElement;

    // Not pre-populated — this is the "worse bug" the ticket asked us to
    // rule out. If this regresses to a default value / defaultValue
    // initializer, this must fail.
    expect(input.value).toBe("");

    // The example code exists ONLY as the placeholder attribute.
    expect(input.getAttribute("placeholder")).toBe("3497-0112-3320");
    expect(screen.getByPlaceholderText("3497-0112-3320")).toBe(input);

    // It must never appear as real rendered text content anywhere on the
    // page (that would mean it leaked into a visible label/value instead
    // of staying attribute-only placeholder copy).
    expect(screen.queryByText("3497-0112-3320")).not.toBeInTheDocument();
  });

  it("scopes the pairing-code field inside the shared droplet-shell design-token scope", async () => {
    // This is the actual defect: without a `.droplet-shell` ancestor,
    // `var(--text-muted)` (the dimmed placeholder token defined in
    // components/shell/indigo-tokens.css) is undefined on this page, so the
    // placeholder inherits the full-contrast body text color instead of
    // reading as dimmed/empty. Every other dashboard input (e.g. /devices)
    // gets this scope via `ShellPage`; this page must too.
    render(<AddMatterDevicePage />);
    const input = await screen.findByLabelText(/enter the pairing code/i);
    expect(input.closest(".droplet-shell")).not.toBeNull();
  });

  it("keeps the Commission button disabled while the field is empty", async () => {
    render(<AddMatterDevicePage />);
    await screen.findByLabelText(/enter the pairing code/i);
    expect(screen.getByRole("button", { name: /commission/i })).toBeDisabled();
  });
});
