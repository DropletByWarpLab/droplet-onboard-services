/**
 * WARP-1405 — Settings → Device information shows backup health. Pins: each
 * health value's wording, a warning only when backups have stopped, lesser
 * roles render nothing, a failed load is a dash — never a fake "OK".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchBackupStatus = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchBackupStatus: (...a: unknown[]) => fetchBackupStatus(...a),
}));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "stefan", role: mockRole } }),
}));

import { BackupRows, BACKUP_ACTION, backupCopy } from "./BackupRows";
import type { BackupStatus } from "@/lib/api";

function st(over: Partial<BackupStatus> = {}): BackupStatus {
  return {
    health: "healthy",
    alerting: false,
    reason: null,
    lastSuccessAt: "2026-09-22T03:20:00.000Z",
    lastFailureAt: null,
    lastAttemptAt: "2026-09-22T03:20:00.000Z",
    lastRekeyAt: null,
    windowHours: 48,
    ...over,
  };
}

beforeEach(() => {
  fetchBackupStatus.mockReset();
  mockRole = "owner";
});

describe("backupCopy", () => {
  it("healthy / pending / failing carry no warning", () => {
    expect(backupCopy(st()).warning).toBeNull();
    expect(backupCopy(st({ health: "pending" })).value).toMatch(/first nightly backup/);
    expect(backupCopy(st({ health: "failing" })).warning).toBeNull();
  });

  it("overdue names the window, the failing phase and the action", () => {
    const c = backupCopy(st({ health: "overdue", alerting: true, reason: "dumping the databases (exit 1)" }));
    expect(c.value).toMatch(/Backups stopped/);
    expect(c.warning).toContain("48 hours");
    expect(c.warning).toContain("dumping the databases");
    expect(c.warning).toContain(BACKUP_ACTION);
  });

  it("key_mismatch says the store no longer opens with this Droplet's key", () => {
    expect(backupCopy(st({ health: "key_mismatch", alerting: true })).warning).toMatch(/no longer opens/);
  });

  it("not_reporting is 'unavailable', never 'OK'", () => {
    expect(backupCopy(st({ health: "not_reporting" })).value).toBe("Status unavailable");
  });
});

describe("<BackupRows />", () => {
  it("renders the warning for an owner when backups stopped", async () => {
    fetchBackupStatus.mockResolvedValue(st({ health: "overdue", alerting: true }));
    render(<BackupRows />);
    await waitFor(() => expect(screen.getByTestId("backup-warning")).toBeTruthy());
  });

  it("renders nothing for a family member", () => {
    mockRole = "family";
    const { container } = render(<BackupRows />);
    expect(container.innerHTML).toBe("");
    expect(fetchBackupStatus).not.toHaveBeenCalled();
  });

  it("a failed load is a dash", async () => {
    fetchBackupStatus.mockRejectedValue(new Error("500"));
    render(<BackupRows />);
    await waitFor(() => expect(screen.getByTestId("backup-row").textContent).toContain("—"));
  });
});
