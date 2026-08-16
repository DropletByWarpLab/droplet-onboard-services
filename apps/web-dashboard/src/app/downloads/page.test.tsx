/**
 * /downloads — the states the page must not get wrong.
 *
 * The risk on this surface is not layout, it is CLAIMS: telling a
 * customer a file is signed when nothing verified a signature, or
 * showing a download button for a platform that ships through a store.
 * These tests pin the claims, not the pixels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import type { AppDownloadCatalog } from "@/lib/types";

const fetchAppDownloadsMock = vi.fn();

// next/link renders nothing useful without the app router in jsdom; the
// repo's standard shim renders a plain anchor so link assertions work.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...props }, children),
}));

// PARTIAL mock: ShellPage's status chip pulls fetchSystemHealth from this
// same module, so replacing it wholesale breaks the page chrome rather
// than the thing under test.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchAppDownloads: (...args: unknown[]) => fetchAppDownloadsMock(...args),
}));

import DownloadsPage from "./page";

const WINDOWS_CATALOG: AppDownloadCatalog = {
  available: true,
  reason: null,
  detail: null,
  attestation: "digest-only",
  generatedAt: "2026-08-13T10:00:00.000Z",
  platforms: [
    {
      platform: "windows",
      version: "0.2.0",
      primary: "Droplet_0.2.0_x64-setup.exe",
      storeUrl: null,
      note: null,
      minOsVersion: "Windows 10 (1809) or newer",
      releasedAt: null,
      assets: [
        {
          name: "Droplet_0.2.0_x64-setup.exe",
          kind: "installer",
          size: 217505079,
          sha256: "7200bdf7f883ae6ce4984e7d1694d39097e4fc7fb526414d1fe02bbc2d74ef29",
          signs: null,
          signatureAlgorithm: null,
          url: "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe",
        },
        {
          name: "Droplet_0.2.0_x64-setup.exe.sig",
          kind: "signature",
          size: 200,
          sha256: "b".repeat(64),
          signs: "Droplet_0.2.0_x64-setup.exe",
          signatureAlgorithm: "minisign-ed25519",
          url: "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe.sig",
        },
      ],
    },
    {
      platform: "ios",
      version: "1.0.0",
      primary: null,
      storeUrl: "https://testflight.apple.com/join/abc123",
      note: "iPhone and iPad builds are distributed through TestFlight.",
      minOsVersion: null,
      releasedAt: null,
      assets: [],
    },
  ],
};

beforeEach(() => {
  fetchAppDownloadsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("/downloads — a staged installer", () => {
  it("offers the installer with its size and full digest", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);

    const link = await screen.findByRole("link", {
      name: /download for windows/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe",
    );
    expect(link).toHaveAttribute("download");

    // The digest is truncated for display but the FULL value must remain
    // reachable — it is what a customer verifies the download against.
    const digest = await screen.findByTitle(
      "7200bdf7f883ae6ce4984e7d1694d39097e4fc7fb526414d1fe02bbc2d74ef29",
    );
    expect(digest).toBeInTheDocument();
  });

  it("offers the detached signature as a secondary link, not the main action", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);

    const sig = await screen.findByRole("link", { name: /minisign/i });
    expect(sig).toHaveAttribute(
      "href",
      "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe.sig",
    );
  });

  it("links onward to pairing — installing is only half the job", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);

    const pair = await screen.findByRole("link", { name: /pairing code/i });
    expect(pair).toHaveAttribute("href", "/devices/pair");
  });
});

describe("/downloads — claims match what was verified", () => {
  it("says 'Integrity checked', NOT 'Signed', for a digest-only catalog", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);

    expect(await screen.findByText(/integrity checked/i)).toBeInTheDocument();
    expect(screen.queryByText(/^signed$/i)).not.toBeInTheDocument();
  });

  it("says 'Signed' only when the catalog signature actually verified", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      attestation: "signed",
    });
    render(<DownloadsPage />);

    expect(await screen.findByText(/^signed$/i)).toBeInTheDocument();
  });
});

describe("/downloads — store-distributed platforms", () => {
  it("links iOS out to TestFlight instead of faking a download", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);

    const store = await screen.findByRole("link", {
      name: /get it for iphone & ipad/i,
    });
    expect(store).toHaveAttribute(
      "href",
      "https://testflight.apple.com/join/abc123",
    );
    // Opening a store is leaving the box; do it without handing the
    // destination a window reference.
    expect(store).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // And there must be no iOS "download" button anywhere.
    expect(
      screen.queryByRole("link", { name: /download for iphone/i }),
    ).not.toBeInTheDocument();
  });
});

describe("/downloads — honest empty and error states", () => {
  it("explains a box with nothing staged, without looking broken", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "catalog_missing",
      detail: "no catalog.json",
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    expect(await screen.findByText(/no apps are staged/i)).toBeInTheDocument();
    // Never a raw failure identifier in customer-facing copy.
    expect(screen.queryByText(/catalog_missing/)).not.toBeInTheDocument();
  });

  it("translates a signature failure into plain language", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "signature_failed",
      detail: "cosign said no",
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    expect(
      await screen.findByText(/failed its signature check/i),
    ).toBeInTheDocument();
  });

  it("degrades to an honest line for a reason it has no copy for", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "some_future_reason",
      detail: null,
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    // Unhelpful but honest beats a blank page.
    expect(
      await screen.findByText(/isn't available right now/i),
    ).toBeInTheDocument();
  });

  it("surfaces a transport failure as its own state", async () => {
    fetchAppDownloadsMock.mockRejectedValue(new Error("network down"));
    render(<DownloadsPage />);

    expect(await screen.findByText(/can't reach the box/i)).toBeInTheDocument();
  });

  it("never renders a download button while the catalog is unavailable", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "digest_mismatch",
      detail: null,
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    await waitFor(() =>
      expect(screen.getByText(/no apps available/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /download for/i })).toBeNull();
  });
});
