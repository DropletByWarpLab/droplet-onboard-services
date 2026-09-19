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

    const empty = await screen.findByText(
      /no apps have been added to this box/i,
    );
    expect(empty).toBeInTheDocument();
    // Never a raw failure identifier in customer-facing copy.
    expect(screen.queryByText(/catalog_missing/)).not.toBeInTheDocument();
    // It must not PROMISE that an update will deliver the app. Nothing about
    // a box update stages an installer — an operator does — so the old copy
    // ("the next box update will bring them") left the reader waiting for
    // something that was never coming. Narrow on the promise, not the word:
    // telling someone an update will NOT bring it is exactly right.
    expect(empty.textContent ?? "").not.toMatch(/update will bring/i);
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

// ---------------------------------------------------------------------------
// WARP-2666 — the states a partially-staged box actually reaches
// ---------------------------------------------------------------------------
// The moment Windows staging succeeds, the catalog IS available and the page
// renders a card for all five platforms. Everything below is about what those
// other four cards say, because that is the copy a customer reads on the first
// box that ever shipped with a real installer on it.
describe("/downloads — honest per-platform copy", () => {
  it("never tells a phone user to ask for an installer the box cannot serve", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);
    await screen.findByRole("link", { name: /download for windows/i });

    // The old single fallback said "Ask whoever set it up to add the
    // {label} installer" for EVERY unstaged platform, Android included —
    // sending a family member to chase a file nobody can produce.
    expect(screen.queryByText(/add the android installer/i)).toBeNull();
    expect(screen.queryByText(/add the iphone/i)).toBeNull();
  });

  it("says where a phone app will come from instead", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      // Windows staged, Android not in the catalog at all — the state a box
      // is in the day the first Windows installer is staged.
      platforms: WINDOWS_CATALOG.platforms.filter(
        (p) => p.platform === "windows",
      ),
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);
    await screen.findByRole("link", { name: /download for windows/i });

    expect(await screen.findByText(/google play/i)).toBeInTheDocument();
    // iOS must never imply the box could serve it.
    expect(
      await screen.findByText(/can’t install apps straight from this box/i),
    ).toBeInTheDocument();
  });

  it("explains the SmartScreen prompt on the Windows card", async () => {
    // There is no Authenticode/EV certificate in release.yml, so "unknown
    // publisher" is literally what the customer sees after clicking Download.
    // An unexplained warning is the difference between a completed install
    // and an abandoned one.
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);
    await screen.findByRole("link", { name: /download for windows/i });

    expect(await screen.findByText(/unknown publisher/i)).toBeInTheDocument();
    expect(screen.getByText(/run anyway/i)).toBeInTheDocument();
  });

  it("does not advertise a version for a platform that can give you nothing", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      platforms: [
        {
          platform: "android",
          version: "9.9.9",
          primary: null,
          storeUrl: null,
          note: null,
          minOsVersion: null,
          releasedAt: null,
          assets: [],
        },
      ],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    await waitFor(() =>
      expect(screen.getByText(/google play/i)).toBeInTheDocument(),
    );
    // A "v9.9.9" chip on a card with no download and no store link
    // advertises a release that is not here.
    expect(screen.queryByText("v9.9.9")).toBeNull();
  });

  it("names a dangling primary as a box fault, not an empty box", async () => {
    // The catalog declares a primary that is not in its own asset list. That
    // used to fall through to "nothing has been added yet", which reads as a
    // box nobody set up — when in fact something IS staged and wrong.
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      platforms: [
        {
          platform: "windows",
          version: "0.2.0",
          primary: "Droplet_0.2.0_x64-setup.exe",
          storeUrl: null,
          note: null,
          minOsVersion: null,
          releasedAt: null,
          assets: [],
        },
      ],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    expect(await screen.findByText(/can’t find the file for it/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download for/i })).toBeNull();
  });
});

describe("/downloads — an expired session is not a corrupted box", () => {
  it("tells the customer to sign in again rather than blaming the catalog", async () => {
    // fetchAppDownloads maps 401/403 to `not_authenticated`. Before that, a
    // 401 body ({error: "..."}) had no boolean `available` and was rendered as
    // "the box's app catalog is corrupted" — and because this page fetches
    // once on mount with no retry, that lie was permanent until a reload.
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "not_authenticated",
      detail: "Your session has expired.",
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/corrupted/i)).toBeNull();
  });
});

describe("/downloads — no false provenance", () => {
  it("never claims an update will bring the apps", async () => {
    // The page used to tell customers "They're built into the appliance
    // image, so the next box update will bring them." No update ever has or
    // will: installers are git-ignored and staged by an operator. This grep
    // is the same technique tests/app-downloads-stage.test.sh applies to the
    // tracked files — the claim has regrown once already.
    fetchAppDownloadsMock.mockResolvedValue({
      available: false,
      reason: "catalog_missing",
      detail: null,
      attestation: null,
      platforms: [],
    } satisfies AppDownloadCatalog);
    const { container } = render(<DownloadsPage />);

    await waitFor(() =>
      expect(screen.getByText(/no apps have been added/i)).toBeInTheDocument(),
    );
    expect(container.textContent ?? "").not.toMatch(/update will bring/i);
    expect(container.textContent ?? "").not.toMatch(
      /built into the appliance image/i,
    );
  });
});

// ---------------------------------------------------------------------------
// WARP-2889 — every staged package is reachable, not just the primary
// ---------------------------------------------------------------------------
// gen-catalog pins every installer format in a platform directory and the API
// serves each one after its digest check. The page used to link only the
// catalog's `primary`, so the Tauri bundle's MSI — staged, verified, served —
// was unreachable from the one place a customer looks.
describe("/downloads — every staged package is reachable", () => {
  const windowsEntry = WINDOWS_CATALOG.platforms[0]!;
  const MSI = {
    name: "Droplet_0.2.0_x64_en-US.msi",
    kind: "installer" as const,
    size: 211763200,
    sha256: "c".repeat(64),
    signs: null,
    signatureAlgorithm: null,
    url: "/api/app-downloads/windows/Droplet_0.2.0_x64_en-US.msi",
  };
  const TWO_FORMATS: AppDownloadCatalog = {
    ...WINDOWS_CATALOG,
    platforms: [{ ...windowsEntry, assets: [...windowsEntry.assets, MSI] }],
  };

  it("lists the MSI beneath the primary button as its own download", async () => {
    fetchAppDownloadsMock.mockResolvedValue(TWO_FORMATS);
    render(<DownloadsPage />);

    // The main action is still the NSIS exe …
    const main = await screen.findByRole("link", {
      name: /download for windows/i,
    });
    expect(main).toHaveAttribute(
      "href",
      "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe",
    );

    // … and the MSI is a real, separate download: linked, downloadable, and
    // NOT dressed up as a second primary button.
    const msi = await screen.findByRole("link", {
      name: /Droplet_0\.2\.0_x64_en-US\.msi/,
    });
    expect(msi).toHaveAttribute("href", MSI.url);
    expect(msi).toHaveAttribute("download");
    expect(msi).not.toHaveClass("dl-btn");

    // Its own digest is reachable too — a customer verifies the file they
    // actually downloaded, not the other format's.
    expect(screen.getByTitle("c".repeat(64))).toBeInTheDocument();
  });

  it("shows no 'also available' list when a platform has a single installer", async () => {
    fetchAppDownloadsMock.mockResolvedValue(WINDOWS_CATALOG);
    render(<DownloadsPage />);
    await screen.findByRole("link", { name: /download for windows/i });

    expect(screen.queryByText(/also available/i)).toBeNull();
  });

  it("still offers a download when installers are staged but no primary is named", async () => {
    // `primary` is optional in the catalog schema. A catalog that stages an
    // installer without naming one used to render "No Windows app has been
    // added to this box yet" — false, with the API serving the file.
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      platforms: [{ ...windowsEntry, primary: null }],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    const main = await screen.findByRole("link", {
      name: /download for windows/i,
    });
    expect(main).toHaveAttribute(
      "href",
      "/api/app-downloads/windows/Droplet_0.2.0_x64-setup.exe",
    );
    expect(screen.queryByText(/no windows app has been added/i)).toBeNull();
  });

  it("explains the sideload prompt next to a staged Android APK", async () => {
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      platforms: [
        {
          platform: "android",
          version: "0.3.0",
          primary: "Droplet_0.3.0.apk",
          storeUrl: null,
          note: null,
          minOsVersion: "Android 8.0 or newer",
          releasedAt: null,
          assets: [
            {
              name: "Droplet_0.3.0.apk",
              kind: "installer",
              size: 41492466,
              sha256: "d".repeat(64),
              signs: null,
              signatureAlgorithm: null,
              url: "/api/app-downloads/android/Droplet_0.3.0.apk",
            },
          ],
        },
      ],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);

    const apk = await screen.findByRole("link", {
      name: /download for android/i,
    });
    expect(apk).toHaveAttribute("href", "/api/app-downloads/android/Droplet_0.3.0.apk");
    expect(apk).toHaveAttribute("download");
    expect(
      screen.getByText(/allow installs from this browser/i),
    ).toBeInTheDocument();
    // A staged APK is the supported path today; the Android card must not
    // fall through to the "isn’t published yet" copy for an unstaged phone
    // app. (The iOS card, unstaged in this fixture, still says its own.)
    expect(screen.queryByText(/the android app isn’t published yet/i)).toBeNull();
  });

  it("keeps the Windows SmartScreen note true without a staged signature", async () => {
    // The old copy said the installer "is signed for the app's own updater".
    // A build made with createUpdaterArtifacts:false has no minisign .sig, so
    // the note must explain the warning without claiming a signature exists.
    fetchAppDownloadsMock.mockResolvedValue({
      ...WINDOWS_CATALOG,
      platforms: [
        {
          ...windowsEntry,
          assets: windowsEntry.assets.filter((a) => a.kind === "installer"),
        },
      ],
    } satisfies AppDownloadCatalog);
    render(<DownloadsPage />);
    await screen.findByRole("link", { name: /download for windows/i });

    expect(await screen.findByText(/unknown publisher/i)).toBeInTheDocument();
    expect(screen.queryByText(/signed for the app/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /minisign/i })).toBeNull();
  });
});
