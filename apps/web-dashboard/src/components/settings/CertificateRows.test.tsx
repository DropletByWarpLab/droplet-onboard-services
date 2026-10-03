/**
 * WARP-2944 — Settings → Device information shows the certificate lifecycle.
 *
 * Pins: every state's row value and whether a warning appears; the warning
 * carries the ONE action and the 60-day rule; the copy is honest that the
 * Droplet apps keep working (they pair by the box's key) while browsers need
 * the public certificate; lesser roles render nothing; a failed load is a
 * dash, never a fake "OK".
 */
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

import { CertificateRows, RENEW_ACTION, certificateCopy } from "./CertificateRows";
import type { TlsCertificate } from "@/lib/api";

/** The known bootstrap leaf's key fingerprint (served-cert-pin.test.ts). */
const FINGERPRINT =
  "F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B 8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C";

function cert(over: Partial<TlsCertificate> = {}): TlsCertificate {
  return {
    state: "LE_ISSUED",
    fqdn: "mybox.droplet-us.com",
    notAfter: "2026-11-19T00:00:00.000Z",
    daysLeft: 60,
    renewsInDays: 30,
    expiringSoon: false,
    hqConfigured: true,
    checkedAt: "2026-09-20T04:00:00.000Z",
    fingerprint: FINGERPRINT,
    ...over,
  };
}

beforeEach(() => {
  mockRole = "owner";
  fetchTlsCertificate.mockReset();
});

describe("certificateCopy — one line per state", () => {
  it("an issued certificate says when the box renews, with no warning", () => {
    const c = certificateCopy(cert());
    expect(c.value).toBe("mybox.droplet-us.com · renews in 30 days");
    expect(c.warning).toBeNull();
  });

  it("inside the renew window it says renewing; inside the last week it warns with the action", () => {
    expect(certificateCopy(cert({ daysLeft: 20, renewsInDays: 0 })).value).toBe(
      "mybox.droplet-us.com · renewing (20 days left)",
    );
    const c = certificateCopy(cert({ daysLeft: 5, renewsInDays: 0, expiringSoon: true }));
    expect(c.warning).toContain("Expires in 5 days");
    expect(c.warning).toContain(RENEW_ACTION);
    expect(c.warning).toContain("every 60 days");
  });

  it("renewal failing names the failure, what still works, and the one action", () => {
    const c = certificateCopy(cert({ state: "LE_RENEW_FAILED", daysLeft: 12, renewsInDays: 0 }));
    expect(c.value).toBe("mybox.droplet-us.com · renewal failing");
    expect(c.warning).toContain("could not reach the certificate service");
    expect(c.warning).toContain("valid for 12 days more");
    expect(c.warning).toContain(RENEW_ACTION);
    // Past expiry: browsers warn, the apps keep working — both said.
    const expired = certificateCopy(cert({ state: "LE_RENEW_FAILED", daysLeft: -3, renewsInDays: 0, expiringSoon: true }));
    expect(expired.warning).toContain("expired 3 days ago");
    expect(expired.warning).toContain("browsers will warn");
    expect(expired.warning).toContain("apps keep working");
  });

  it("the self-signed bootstrap certificate is not an error: the apps pair by its key, browsers wait for HQ", () => {
    const c = certificateCopy(cert({ state: "BOOTSTRAP_SELF_SIGNED", fqdn: null, daysLeft: null, renewsInDays: null }));
    expect(c.value).toBe("Self-signed (the Droplet's own key)");
    expect(c.warning).toBeNull();
    expect(c.note).toContain("pair by this key");
    expect(c.note).toContain("Browsers show a warning until");
    // Air-gapped (no HQ): the documented exception, said as such.
    const air = certificateCopy(cert({ state: "BOOTSTRAP_SELF_SIGNED", fqdn: null, daysLeft: null, renewsInDays: null, hqConfigured: false }));
    expect(air.note).toContain("not set up for a public certificate");
    expect(air.note).toContain("the apps do not");
  });
});

describe("<CertificateRows />", () => {
  it("renders the row and the warning for a failing renewal", async () => {
    fetchTlsCertificate.mockResolvedValue(cert({ state: "LE_RENEW_FAILED", daysLeft: 12, renewsInDays: 0 }));
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("renewal failing"));
    expect(screen.getByRole("alert")).toHaveTextContent("could not reach the certificate service");
  });

  it("renders the row without an alert when nothing needs the owner", async () => {
    fetchTlsCertificate.mockResolvedValue(cert());
    render(<CertificateRows />);
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("renews in 30 days"));
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
    fetchTlsCertificate.mockResolvedValue(cert({ state: "BOOTSTRAP_SELF_SIGNED", fqdn: null, daysLeft: null, renewsInDays: null }));
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
    await waitFor(() => expect(screen.getByTestId("certificate-row")).toHaveTextContent("renews in 30 days"));
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
