/**
 * WARP-3608 — Settings → Device information states whether the data disk is
 * encrypted. Pins: each enum value's wording, a warning only for
 * not_encrypted, an absent field reads "unavailable" (never "encrypted"),
 * lesser roles render nothing, a failed load is a dash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchDrives = vi.fn();
vi.mock("@/lib/api", () => ({ fetchDrives: (...a: unknown[]) => fetchDrives(...a) }));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "stefan", role: mockRole } }),
}));

import { DiskEncryptionRow, encryptionCopy } from "./DiskEncryptionRow";

beforeEach(() => {
  fetchDrives.mockReset();
  mockRole = "owner";
});

describe("encryptionCopy", () => {
  it("only not_encrypted carries a warning", () => {
    expect(encryptionCopy("tpm_sealed").warning).toBeNull();
    expect(encryptionCopy("recovery_key_only").warning).toBeNull();
    expect(encryptionCopy("unknown").warning).toBeNull();
    expect(encryptionCopy("not_encrypted").value).toBe("Not encrypted");
    expect(encryptionCopy("not_encrypted").warning).toMatch(/without encryption/);
  });
});

describe("DiskEncryptionRow", () => {
  it("shows the warning when the box reports not_encrypted", async () => {
    fetchDrives.mockResolvedValue({ system_disk: { encryption: "not_encrypted" } });
    render(<DiskEncryptionRow />);
    await waitFor(() => expect(screen.getByTestId("encryption-warning")).toBeTruthy());
    expect(screen.getByTestId("encryption-row").textContent).toContain("Not encrypted");
  });

  it("a bridge that does not report the field reads unavailable, not encrypted", async () => {
    fetchDrives.mockResolvedValue({ system_disk: {} });
    render(<DiskEncryptionRow />);
    await waitFor(() =>
      expect(screen.getByTestId("encryption-row").textContent).toContain("Status unavailable"),
    );
    expect(screen.queryByTestId("encryption-warning")).toBeNull();
  });

  it("renders nothing for a member", () => {
    mockRole = "family";
    render(<DiskEncryptionRow />);
    expect(screen.queryByTestId("encryption-row")).toBeNull();
    expect(fetchDrives).not.toHaveBeenCalled();
  });

  it("a failed load is a dash", async () => {
    fetchDrives.mockRejectedValue(new Error("boom"));
    render(<DiskEncryptionRow />);
    await waitFor(() => expect(screen.getByTestId("encryption-row").textContent).toContain("—"));
  });
});
