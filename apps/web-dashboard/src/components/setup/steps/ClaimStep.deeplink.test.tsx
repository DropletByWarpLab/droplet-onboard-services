/**
 * Scan-to-claim deep link (design handoff "PyPortal First Boot — Claim
 * Code"): the PyPortal claim screen's QR encodes `/setup?c=<CODE>`, so
 * landing here from a scan must prefill the claim-code field — and nothing
 * more. No auto-submit (claiming stays a deliberate human action under the
 * WARP-631 rate-limit posture), no overwriting, and a junk param degrades to
 * the normal empty field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ClaimStep } from "./ClaimStep";

const fetchApplianceContract = vi.fn();
const postClaim = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchApplianceContract: (...a: unknown[]) => fetchApplianceContract(...a),
  postClaim: (...a: unknown[]) => postClaim(...a),
  ClaimError: class ClaimError extends Error {
    kind = "wrong_code";
  },
}));

const SPEC = { label: "Compute", value: "x", online: true };
const CONTRACT = {
  appliance_id: "DRP-4F9A2C",
  compute: SPEC,
  storage: { ...SPEC, label: "Storage" },
  network: { ...SPEC, label: "Network" },
  display: { ...SPEC, label: "Display" },
  supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "ok" },
};

const codeInput = () =>
  screen.getByPlaceholderText(/DRPL/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  fetchApplianceContract.mockResolvedValue(CONTRACT);
  window.history.replaceState(null, "", "/setup");
});

describe("ClaimStep deep link", () => {
  it("prefills the code from ?c= (normalized, no auto-submit)", async () => {
    window.history.replaceState(null, "", "/setup?c=drpl-7k2q-9f4m");
    render(<ClaimStep onComplete={vi.fn()} />);
    await waitFor(() =>
      expect(codeInput().value).toBe("DRPL7K2Q9F4M"),
    );
    // Prefill only — the claim POST stays behind the explicit CTA.
    expect(postClaim).not.toHaveBeenCalled();
  });

  it("ignores a junk ?c= param", async () => {
    window.history.replaceState(null, "", "/setup?c=%2e%2e%2f");
    render(<ClaimStep onComplete={vi.fn()} />);
    await waitFor(() => expect(fetchApplianceContract).toHaveBeenCalled());
    expect(codeInput().value).toBe("");
  });

  it("renders the normal empty field without the param", async () => {
    render(<ClaimStep onComplete={vi.fn()} />);
    await waitFor(() => expect(fetchApplianceContract).toHaveBeenCalled());
    expect(codeInput().value).toBe("");
  });
});
