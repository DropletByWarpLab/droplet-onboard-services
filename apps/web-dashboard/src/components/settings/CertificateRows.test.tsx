/** Installed HTTPS certificate metadata, local trust guidance and permissions. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchTlsCertificate = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchTlsCertificate: (...a: unknown[]) => fetchTlsCertificate(...a),
}));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "stefan", role: mockRole } }),
}));

import { CertificateRows, CERTIFICATE_ACTION, certificateCopy } from "./CertificateRows";
import type { TlsCertificate } from "@/lib/api";

/** The known bootstrap leaf's key fingerprint (served-cert-pin.test.ts). */
const FINGERPRINT =
  "F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B 8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C";

function cert(over: Partial<TlsCertificate> = {}): TlsCertificate {
  return {
    state: "LOCAL_CERTIFICATE",
    fqdn: "droplet-ai.lan",
    notAfter: "2026-11-19T00:00:00.000Z",
    daysLeft: 60,
    renewsInDays: null,
    coversInternalHostname: true,
    expiringSoon: false,
    hqConfigured: false,
    checkedAt: "2026-09-20T04:00:00.000Z",
    fingerprint: FINGERPRINT,
    ...over,
  };
}

beforeEach(() => {
  mockRole = "owner";
  fetchTlsCertificate.mockReset();
});

describe("certificateCopy — installed certificate", () => {
  it("shows the served leaf's expiry without cloud renewal promises", () => {
    const copy = certificateCopy(cert());
    expect(copy.value).toBe("droplet-ai.lan · valid for 60 days more");
    expect(copy.warning).toBeNull();
    expect(copy.note).toContain("may need to trust");
    expect(copy.note).not.toMatch(/renew|HQ|public certificate/);
  });
  it("warns when the installed certificate is close to expiry", () => {
    const copy = certificateCopy(cert({ daysLeft: 5, expiringSoon: true }));
    expect(copy.warning).toContain("Expires in 5 days");
    expect(copy.warning).toContain(CERTIFICATE_ACTION);
  });
  it("reports an expired leaf and how to replace it", () => {
    const copy = certificateCopy(cert({ daysLeft: -3, expiringSoon: true }));
    expect(copy.value).toContain("expired 3 days ago");
    expect(copy.warning).toContain("browsers will warn");
    expect(copy.warning).toContain(CERTIFICATE_ACTION);
  });
  it("warns about expiry today", () => {
    const copy = certificateCopy(cert({ daysLeft: 0, expiringSoon: true }));
    expect(copy.value).toContain("expires today");
    expect(copy.warning).toContain("expires today");
  });
  it("reports an internal hostname mismatch even when the leaf is unexpired", () => {
    const copy = certificateCopy(cert({ coversInternalHostname: false }));
    expect(copy.warning).toContain("does not cover the internal DNS hostname");
    expect(copy.warning).toContain(CERTIFICATE_ACTION);
  });
  it("combines mismatch and expiry guidance", () => {
    const copy = certificateCopy(cert({ coversInternalHostname: false, daysLeft: -2, expiringSoon: true }));
    expect(copy.warning).toContain("does not cover");
    expect(copy.warning).toContain("has expired");
    expect(copy.warning?.split(CERTIFICATE_ACTION)).toHaveLength(2);
  });
  it("does not imply coverage or expiry when metadata is unavailable", () => {
    const copy = certificateCopy(cert({ coversInternalHostname: null, daysLeft: null, notAfter: null }));
    expect(copy.value).toContain("expiry unavailable");
    expect(copy.note).toContain("Hostname coverage could not be verified");
    expect(copy.warning).toBeNull();
  });
  it("unknown leaf metadata stays unknown instead of claiming a self-signed certificate", () => {
    const copy = certificateCopy(cert({ state: "UNKNOWN", daysLeft: null, notAfter: null, coversInternalHostname: null }));
    expect(copy.value).toBe("Certificate information unavailable");
    expect(copy.note).toContain("couldn't read its installed HTTPS certificate");
    expect(copy.warning).toBeNull();
  });
});

describe("<CertificateRows />", () => {
  it("renders the installed certificate and hostname mismatch warning", async () => {
    fetchTlsCertificate.mockResolvedValue(cert({ coversInternalHostname: false }));
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("valid for 60 days more"));
    expect(screen.getByRole("alert")).toHaveTextContent("does not cover the internal DNS hostname");
  });

  it("renders the row without an alert when nothing needs the owner", async () => {
    fetchTlsCertificate.mockResolvedValue(cert());
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("valid for 60 days more"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed load is a dash, never a fake state", async () => {
    fetchTlsCertificate.mockRejectedValue(new Error("403"));
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("—"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // WARP-3414 — the key fingerprint, in full, four groups to a line, with
  // copy that never presents it as proof.
  it("shows the key fingerprint in full, four groups to a line, selectable, with a Copy action", async () => {
    fetchTlsCertificate.mockResolvedValue(cert());
    render(<CertificateRows />);
    const block = await screen.findByTestId("key-fingerprint");
    expect(block).toHaveTextContent("Key fingerprint (SHA-256)");
    const value = screen.getByTestId("key-fingerprint-value");
    expect(Array.from(value.children).map((l) => l.textContent)).toEqual([
      "F017 AFA8 6AD7 8BED",
      "4ABD E646 90F0 5B7B",
      "8DBB E36B 26E9 C8F4",
      "10E5 36A6 1E3D F25C",
    ]);
    expect(value.className).toContain("select-all");
    expect(screen.getByRole("button", { name: "Copy key fingerprint" })).toBeInTheDocument();
  });

  it("says what the apps do with it, and that this page alone proves nothing", async () => {
    fetchTlsCertificate.mockResolvedValue(cert());
    render(<CertificateRows />);
    await screen.findByTestId("key-fingerprint");
    expect(screen.getByTestId("key-fingerprint-app-copy")).toHaveTextContent(
      "Apps check this fingerprint the first time they connect to a Droplet that uses its own certificate.",
    );
    const notProof = screen.getByTestId("key-fingerprint-not-proof");
    expect(notProof).toHaveTextContent("proves nothing");
    // Not every Droplet has a front panel that can show it (WARP-3418).
    expect(notProof).toHaveTextContent("front panel, if your Droplet has one");
    expect(notProof).toHaveTextContent("setup output");
    expect(notProof).toHaveTextContent("droplet-fingerprint");
  });

  it("shows no fingerprint block when the box has none to offer", async () => {
    fetchTlsCertificate.mockResolvedValue(cert({ fingerprint: null }));
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("valid for 60 days more"));
    expect(screen.queryByTestId("key-fingerprint")).toBeNull();
  });

  it("renders nothing for a family member (Settings is an admin surface)", () => {
    mockRole = "family";
    render(<CertificateRows />);
    expect(screen.queryByTestId("certificate-row")).toBeNull();
    expect(screen.queryByTestId("key-fingerprint")).toBeNull();
    expect(fetchTlsCertificate).not.toHaveBeenCalled();
  });
});
