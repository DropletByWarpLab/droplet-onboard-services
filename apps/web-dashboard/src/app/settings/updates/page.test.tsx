/**
 * WARP-540 — /settings/updates page tests.
 *
 * Contract under test (the five ticket UI elements + copy honesty):
 *   1. current-release card: short SHA, GitHub commit link, "Check now";
 *   2. factory-image box: honest "no OTA applied yet" copy, never a fake
 *      version;
 *   3. pending banner: "Scheduled for 03:00", "Apply now",
 *      "Skip this release" (+ the two-step confirm actually calls the API);
 *   4. apply unavailable: button disabled + honest provisioning note;
 *   5. degraded_health: the red banner renders;
 *   6. history table rows with status verdicts;
 *   7. status-fetch failure: an EXPLICIT error state, no healthy-looking
 *      cards (the "fallback copy masks outages" defect class);
 *   8. settings save: the window time round-trips to the cron PUT.
 *   9. unprovisioned update source (WARP-2133): the standing notice renders
 *      and a source_unauthenticated check reads as a failure, never as
 *      "up to date".
 *
 * ShellPage is mocked to a passthrough (trust-page test pattern) and the
 * api module is fully mocked — no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

const getUpdatesStatus = vi.fn();
const getUpdatesHistory = vi.fn();
const checkForUpdatesNow = vi.fn();
const applyUpdateNow = vi.fn();
const skipPendingUpdate = vi.fn();
const saveUpdateSettings = vi.fn();
vi.mock("@/lib/api", () => ({
  getUpdatesStatus: (...a: unknown[]) => getUpdatesStatus(...a),
  getUpdatesHistory: (...a: unknown[]) => getUpdatesHistory(...a),
  checkForUpdatesNow: (...a: unknown[]) => checkForUpdatesNow(...a),
  applyUpdateNow: (...a: unknown[]) => applyUpdateNow(...a),
  skipPendingUpdate: (...a: unknown[]) => skipPendingUpdate(...a),
  saveUpdateSettings: (...a: unknown[]) => saveUpdateSettings(...a),
}));

import UpdatesSettingsPage from "./page";

const SHA_CURRENT = "a".repeat(40);
const SHA_PENDING = "b".repeat(40);

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: "du-1",
    status: "committed",
    channel: "stable",
    releaseTag: "ota-1-gaaaaaaa",
    gitSha: SHA_CURRENT,
    builtAt: "2026-07-01T00:00:00Z",
    failureReason: null,
    createdAt: "2026-07-01T01:00:00Z",
    updatedAt: "2026-07-01T03:05:00Z",
    ...overrides,
  };
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    current: release(),
    pending: null,
    lastVerdict: release(),
    degraded: false,
    settings: { channel: "stable", applyWindowCron: "0 3 * * *", autoApply: true },
    applyAvailable: true,
    updateSourceAuthenticated: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUpdatesStatus.mockResolvedValue(statusPayload());
  getUpdatesHistory.mockResolvedValue([release()]);
});

describe("/settings/updates — current release card", () => {
  it("shows the short SHA, a GitHub commit link, and Check now", async () => {
    render(<UpdatesSettingsPage />);
    // The short SHA appears on the card AND in the history table row.
    const shas = await screen.findAllByText(SHA_CURRENT.slice(0, 10));
    expect(shas.length).toBeGreaterThanOrEqual(1);
    const link = screen.getByRole("link", { name: /view commit on github/i });
    expect(link).toHaveAttribute(
      "href",
      `https://github.com/DropletByWarpLab/droplet-onboard-services/commit/${SHA_CURRENT}`,
    );
    expect(screen.getByRole("button", { name: /check now/i })).toBeInTheDocument();
  });

  it("says out loud when no OTA release has ever been applied", async () => {
    getUpdatesStatus.mockResolvedValue(statusPayload({ current: null, lastVerdict: null }));
    getUpdatesHistory.mockResolvedValue([]);
    render(<UpdatesSettingsPage />);
    expect(
      await screen.findByText(/no over-the-air update has been applied yet/i),
    ).toBeInTheDocument();
  });

  it("runs a forced check and reports its outcome honestly", async () => {
    checkForUpdatesNow.mockResolvedValue({ outcome: "already_known", gitSha: SHA_CURRENT });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /check now/i }));
    await waitFor(() => expect(checkForUpdatesNow).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/already tracking the latest release/i),
    ).toBeInTheDocument();
  });

  it("reports a failed check as a failure, never silently", async () => {
    checkForUpdatesNow.mockResolvedValue({ outcome: "fetch_failed", detail: "boom" });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /check now/i }));
    expect(await screen.findByText(/check failed/i)).toBeInTheDocument();
  });

  it("says the update source is not provisioned — never 'up to date' (WARP-2133)", async () => {
    // A fresh box with no release-feed credentials gets a 404 it cannot
    // interpret; the poller reports source_unauthenticated and this page
    // must render it as a provisioning gap, not as "no updates, all good".
    checkForUpdatesNow.mockResolvedValue({
      outcome: "source_unauthenticated",
      detail: "releases latest endpoint returned 404 with no DROPLET_OTA_GITHUB_TOKEN configured",
    });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /check now/i }));
    expect(
      await screen.findByText(/update source not provisioned/i),
    ).toBeInTheDocument();
    // And it must not read as a healthy no-release answer.
    expect(
      screen.queryByText(/no release has been published yet/i),
    ).not.toBeInTheDocument();
  });
});

describe("/settings/updates — pending banner", () => {
  const pendingStatus = (over: Record<string, unknown> = {}) =>
    statusPayload({
      pending: release({
        id: "du-2",
        status: "pending",
        gitSha: SHA_PENDING,
        releaseTag: "ota-2-gbbbbbbb",
      }),
      ...over,
    });

  it('shows "Scheduled for 03:00", Apply now, and Skip this release', async () => {
    getUpdatesStatus.mockResolvedValue(pendingStatus());
    render(<UpdatesSettingsPage />);
    expect(await screen.findByText(/scheduled for 03:00/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply now/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /skip this release/i }),
    ).toBeInTheDocument();
  });

  it("says the release waits when auto-apply is off", async () => {
    getUpdatesStatus.mockResolvedValue(
      pendingStatus({
        settings: { channel: "stable", applyWindowCron: "0 3 * * *", autoApply: false },
      }),
    );
    render(<UpdatesSettingsPage />);
    expect(await screen.findByText(/automatic apply is off/i)).toBeInTheDocument();
  });

  it("dispatches apply-now", async () => {
    getUpdatesStatus.mockResolvedValue(pendingStatus());
    applyUpdateNow.mockResolvedValue({ deviceUpdateId: "du-2" });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /apply now/i }));
    await waitFor(() => expect(applyUpdateNow).toHaveBeenCalledTimes(1));
  });

  it("disables Apply now with an honest note when apply isn't provisioned", async () => {
    getUpdatesStatus.mockResolvedValue(pendingStatus({ applyAvailable: false }));
    render(<UpdatesSettingsPage />);
    expect(await screen.findByRole("button", { name: /apply now/i })).toBeDisabled();
    expect(
      screen.getByText(/isn.t available on this box/i),
    ).toBeInTheDocument();
  });

  it("skips only after the inline confirm", async () => {
    getUpdatesStatus.mockResolvedValue(pendingStatus());
    skipPendingUpdate.mockResolvedValue({ deviceUpdateId: "du-2" });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /skip this release/i }));
    // First click arms the confirm — nothing is skipped yet.
    expect(skipPendingUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm skip/i }));
    await waitFor(() => expect(skipPendingUpdate).toHaveBeenCalledTimes(1));
  });

  it("shows in-progress copy (no apply/skip buttons) while a row is applying", async () => {
    getUpdatesStatus.mockResolvedValue(
      pendingStatus({
        pending: release({ id: "du-2", status: "applying", gitSha: SHA_PENDING }),
      }),
    );
    render(<UpdatesSettingsPage />);
    expect(await screen.findByText(/update in progress/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply now/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /skip this release/i }),
    ).not.toBeInTheDocument();
  });
});

describe("/settings/updates — degraded health banner", () => {
  it("renders the red degraded banner when the last verdict is degraded_health", async () => {
    getUpdatesStatus.mockResolvedValue(
      statusPayload({
        degraded: true,
        lastVerdict: release({ status: "failed", failureReason: "degraded_health" }),
      }),
    );
    render(<UpdatesSettingsPage />);
    expect(
      await screen.findByText(/appliance health is degraded/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/rolling back did not restore full health/i),
    ).toBeInTheDocument();
  });
});

describe("/settings/updates — unprovisioned update source (WARP-2133)", () => {
  it("renders a standing notice when the box has no credential for the feed", async () => {
    getUpdatesStatus.mockResolvedValue(statusPayload({ updateSourceAuthenticated: false }));
    render(<UpdatesSettingsPage />);
    expect(await screen.findByText(/update source not provisioned/i)).toBeInTheDocument();
    // The whole point: no "up to date" reading of an unseeable feed.
    expect(
      screen.getByText(/it means this box cannot see whether it is/i),
    ).toBeInTheDocument();
  });

  it("does not render the notice when the update source is provisioned", async () => {
    getUpdatesStatus.mockResolvedValue(statusPayload({ updateSourceAuthenticated: true }));
    render(<UpdatesSettingsPage />);
    await screen.findByRole("button", { name: /check now/i });
    expect(screen.queryByText(/update source not provisioned/i)).not.toBeInTheDocument();
  });

  it("reports a source_unauthenticated check as a failure, never as up to date", async () => {
    checkForUpdatesNow.mockResolvedValue({ outcome: "source_unauthenticated" });
    render(<UpdatesSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /check now/i }));
    expect(
      await screen.findByText(/the update source isn't provisioned on this box/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/nothing new/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no release has been published/i)).not.toBeInTheDocument();
  });
});

describe("/settings/updates — history table", () => {
  it("lists tracked releases with their verdicts", async () => {
    getUpdatesHistory.mockResolvedValue([
      release({ id: "du-3", status: "rolled_back", failureReason: "health_gate_failed" }),
      release({ id: "du-1", status: "committed" }),
    ]);
    render(<UpdatesSettingsPage />);
    expect(await screen.findByText("Rolled back")).toBeInTheDocument();
    expect(screen.getByText("health_gate_failed")).toBeInTheDocument();
    expect(screen.getByText("Committed")).toBeInTheDocument();
  });

  it("uses distinct empty copy when there is genuinely no history", async () => {
    getUpdatesStatus.mockResolvedValue(statusPayload({ current: null, lastVerdict: null }));
    getUpdatesHistory.mockResolvedValue([]);
    render(<UpdatesSettingsPage />);
    expect(
      await screen.findByText(/no releases have been tracked on this box yet/i),
    ).toBeInTheDocument();
  });
});

describe("/settings/updates — status fetch failure (copy honesty)", () => {
  it("shows an explicit error state and renders NO healthy-looking cards", async () => {
    getUpdatesStatus.mockRejectedValue(new Error("network down"));
    getUpdatesHistory.mockRejectedValue(new Error("network down"));
    render(<UpdatesSettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /update status unavailable/i,
    );
    // The failure must never read as "no updates, all healthy".
    expect(
      screen.queryByText(/no over-the-air update has been applied yet/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check now/i })).not.toBeInTheDocument();
    // And the operator gets a retry.
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("/settings/updates — indigo shell fill (WARP-1346)", () => {
  /**
   * The page renders inside `.droplet-shell` (indigo scaffold); its fill
   * must use the shell idiom (inline `var(--text)` / `var(--text-muted)` /
   * `var(--card-bd)` styles, the converted input pattern) — never the
   * legacy violet-system tokens. Source-scan pin in the style of
   * `__tests__/dashboard-classes-guard.test.ts`. Semantic state colors
   * (`text-system-red`, `text-system-green`, …) are allowed by canon and
   * deliberately NOT pinned here.
   */
  const LEGACY_TOKENS: ReadonlyArray<string> = [
    "type-headline",
    "type-subheadline",
    "type-footnote",
    "type-caption-1",
    "text-label-primary",
    "text-label-secondary",
    "text-label-tertiary",
    "dp-input",
    "border-separator",
  ];

  it("uses no legacy design tokens in the page source", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8");
    const hits: string[] = [];
    for (const token of LEGACY_TOKENS) {
      // Whole-token match: not preceded/followed by a word char or `-`,
      // so a longer token never double-counts as its shorter prefix, and
      // an opacity-suffixed token (`…/60`) still counts as its base.
      const re = new RegExp(`(^|[^\\w-])${token}(?![\\w-])`);
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push(`${token} at page.tsx:${i + 1}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("/settings/updates — update window settings", () => {
  it("saves the window time as a daily cron plus the auto-apply flag", async () => {
    saveUpdateSettings.mockResolvedValue({
      channel: "stable",
      applyWindowCron: "30 4 * * *",
      autoApply: false,
    });
    render(<UpdatesSettingsPage />);
    const time = await screen.findByLabelText(/apply updates daily at/i);
    expect((time as HTMLInputElement).value).toBe("03:00");
    fireEvent.change(time, { target: { value: "04:30" } });
    fireEvent.click(screen.getByLabelText(/apply pending updates automatically/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(saveUpdateSettings).toHaveBeenCalledWith({
        applyWindowCron: "30 4 * * *",
        autoApply: false,
      }),
    );
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("is honest that a changed window needs a restart to take effect", async () => {
    render(<UpdatesSettingsPage />);
    expect(
      await screen.findByText(/takes effect after the box.s next restart/i),
    ).toBeInTheDocument();
  });
});
