/**
 * /downloads — get the Droplet client app for whatever you're reading
 * this on.
 *
 * The apps live ON the box and are served by it (GET /api/app-downloads),
 * not fetched from a cloud endpoint. They get there by an operator
 * staging them (scripts/app-downloads/stage.sh) — NOT with the image, so
 * "no apps staged" is the normal state of a box nobody has staged, and
 * the copy must not tell a customer to wait for an update.
 * That is the point: a customer on a LAN with no internet can still
 * install the client, and the bytes are re-verified against the digest
 * that shipped before the box hands them over.
 *
 * "Smart" here means three things, in order of how much they matter:
 *   1. The page leads with THIS browser's platform, so the common case
 *      is one button. Detection is a default, not a lock — every
 *      platform stays visible and one click switches.
 *   2. It states what was actually verified. `digest-only` and `signed`
 *      are different claims and the badge says which one it is; it
 *      never renders "signed" for a catalog nobody checked a signature
 *      on.
 *   3. It is honest when there is nothing to give you. A box with no
 *      artifacts staged says so, and a platform that really ships
 *      through a store links to the store instead of dangling a
 *      download that would not work.
 *
 * No role gate — every authenticated member needs the app for the box
 * they were invited to (the orchestrator route makes the same call).
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AppWindow,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileWarning,
  Loader2,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Sect } from "@/components/shell/primitives";
import { fetchAppDownloads } from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";
import {
  PLATFORM_LABELS,
  detectPlatform,
} from "@/lib/detect-platform";
import type {
  AppDownloadAsset,
  AppDownloadCatalog,
  AppDownloadPlatform,
  AppDownloadPlatformEntry,
} from "@/lib/types";
import "./downloads.css";

/** Render order. Desktop first — the box's own dashboard is most often
 *  opened on one, and the phone apps are store-distributed anyway. */
const PLATFORM_ORDER: AppDownloadPlatform[] = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
];

/**
 * Plain-language reasons. The API's `reason` values are canonical
 * failure identifiers meant for logs and tests; a customer should never
 * be shown `schema_downgrade`. Anything unmapped falls back to a generic
 * line plus the raw reason, so a new failure mode degrades to "unhelpful
 * but honest" rather than a blank page.
 */
const REASON_COPY: Record<string, string> = {
  catalog_missing:
    "No apps have been added to this box yet. It only offers apps that were put on it directly, so waiting for an update won't bring them — whoever set the box up needs to add them.",
  catalog_unreadable:
    "The box couldn't read its app catalog. This is a fault on the box, not on your device.",
  malformed_catalog:
    "The box's app catalog is corrupted, so downloads are turned off until it's repaired.",
  schema_invalid:
    "The box's app catalog didn't pass validation, so downloads are turned off until it's repaired.",
  schema_downgrade:
    "The box's app catalog is older than this software understands. Downloads are off until they match.",
  schema_unsupported:
    "The box's app catalog is newer than this software understands. Update the box, then try again.",
  signature_missing:
    "Signature checking is switched on, but the catalog isn't signed. The box refuses to serve unverified apps.",
  signature_failed:
    "The app catalog failed its signature check. The box refuses to serve it.",
  malformed_response:
    "The box returned an app catalog this page couldn't read.",
};

function reasonCopy(reason: string | null, detail: string | null): string {
  if (!reason) return detail ?? "The app catalog isn't available right now.";
  return (
    REASON_COPY[reason] ??
    `The app catalog isn't available right now (${reason}).`
  );
}

/** Short, copyable digest. Full value stays available via the copy button
 *  and the title attribute — truncation is display-only. */
function shortDigest(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-8)}`;
}

function CopyDigest({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // `navigator.clipboard` is undefined on a non-secure origin. A box
    // reached over plain http on the LAN is exactly that case, so this
    // degrades to "nothing happens" instead of throwing — the digest is
    // still selectable as text.
    void navigator.clipboard
      ?.writeText(sha256)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* non-secure origin or denied permission — text stays selectable */
      });
  }, [sha256]);

  return (
    <button
      type="button"
      onClick={copy}
      className="digest"
      title={sha256}
      aria-label={copied ? "SHA-256 copied" : "Copy the full SHA-256"}
    >
      <code>{shortDigest(sha256)}</code>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/**
 * One platform's card. Four distinct states, because collapsing them
 * would mean lying in at least one:
 *   - a real installer to download
 *   - store-distributed (Android / iOS): link out, no fake download
 *   - listed but nothing staged: say so
 *   - not in the catalog at all: say that instead of implying "soon"
 */
function PlatformCard({
  platform,
  entry,
  recommended,
}: {
  platform: AppDownloadPlatform;
  entry: AppDownloadPlatformEntry | undefined;
  recommended: boolean;
}) {
  const label = PLATFORM_LABELS[platform];
  const isMobile = platform === "android" || platform === "ios";

  const primary: AppDownloadAsset | undefined = entry?.primary
    ? entry.assets.find((a) => a.name === entry.primary)
    : undefined;

  // A detached signature over the primary installer, offered as a
  // secondary "verify this yourself" link rather than a second download.
  const signature = primary
    ? entry?.assets.find((a) => a.kind === "signature" && a.signs === primary.name)
    : undefined;

  return (
    <Card
      icon={isMobile ? <Smartphone size={16} /> : <AppWindow size={16} />}
      title={label}
      meta={entry ? `v${entry.version}` : undefined}
      className={recommended ? "dl-card dl-card-rec" : "dl-card"}
    >
      {recommended ? (
        <div className="dl-rec">
          <Badge kind="info">Detected — this device</Badge>
        </div>
      ) : null}

      {primary ? (
        <>
          <a className="dl-btn" href={primary.url} download>
            <Download size={15} />
            Download for {label}
          </a>
          <dl className="dl-meta">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(primary.size)}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <CopyDigest sha256={primary.sha256} />
              </dd>
            </div>
            {entry?.minOsVersion ? (
              <div>
                <dt>Requires</dt>
                <dd>{entry.minOsVersion}</dd>
              </div>
            ) : null}
          </dl>
          {signature ? (
            <p className="dl-note">
              <a href={signature.url} download>
                {signature.signatureAlgorithm ?? "Detached"} signature
              </a>{" "}
              — optional, for verifying the installer yourself before you
              run it.
            </p>
          ) : null}
        </>
      ) : entry?.storeUrl ? (
        <>
          <a
            className="dl-btn dl-btn-secondary"
            href={entry.storeUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={15} />
            Get it for {label}
          </a>
          <p className="dl-note">
            {entry.note ??
              `The ${label} app is distributed through its app store, so it updates with the rest of your apps.`}
          </p>
        </>
      ) : (
        <p className="dl-note dl-note-muted">
          {entry?.note ??
            `No ${label} app has been added to this box yet. Ask whoever set it up to add the ${label} installer.`}
        </p>
      )}
    </Card>
  );
}

export default function DownloadsPage() {
  const [catalog, setCatalog] = useState<AppDownloadCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detected, setDetected] = useState<AppDownloadPlatform | null>(null);

  // Detection runs in an effect, never during render: `navigator` does
  // not exist during SSR, and reading it in the render body would
  // hydrate into a different tree than the server produced.
  useEffect(() => {
    setDetected(detectPlatform());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAppDownloads(controller.signal)
      .then((body) => setCatalog(body))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : "Couldn't reach the box to list the apps.",
        );
      });
    return () => controller.abort();
  }, []);

  const byPlatform = useMemo(() => {
    const map = new Map<AppDownloadPlatform, AppDownloadPlatformEntry>();
    for (const entry of catalog?.platforms ?? []) map.set(entry.platform, entry);
    return map;
  }, [catalog]);

  // Lead with the detected platform, keeping the rest in stable order.
  const ordered = useMemo(() => {
    if (!detected) return PLATFORM_ORDER;
    return [detected, ...PLATFORM_ORDER.filter((p) => p !== detected)];
  }, [detected]);

  const attestation = catalog?.attestation ?? null;

  return (
    <ShellPage
      icon={<Download size={15} />}
      label="Get the app"
      title="Get the Droplet app"
      sub="Install the app on this device, then pair it with your box."
    >
      {loadError ? (
        <Card icon={<FileWarning size={16} />} title="Can't reach the box">
          <p className="dl-note">{loadError}</p>
        </Card>
      ) : catalog === null ? (
        <Card>
          <p className="dl-note dl-loading">
            <Loader2 size={14} className="spin" /> Looking for apps on this
            box…
          </p>
        </Card>
      ) : !catalog.available ? (
        <Card icon={<FileWarning size={16} />} title="No apps available">
          <p className="dl-note">{reasonCopy(catalog.reason, catalog.detail)}</p>
        </Card>
      ) : (
        <>
          {/* The verification claim, stated exactly as strongly as it was
              actually established — never stronger. */}
          <Card
            icon={<ShieldCheck size={16} />}
            title="Served and verified by your box"
            meta={
              attestation === "signed" ? (
                <Badge kind="ok">Signed</Badge>
              ) : (
                <Badge kind="ok">Integrity checked</Badge>
              )
            }
          >
            <p className="dl-note">
              These installers live on your box — nothing is fetched from the
              internet. Before sending a file, the box re-checks its SHA-256
              against the one recorded when the app was added, and refuses to
              serve it if a single byte differs.
              {attestation === "signed"
                ? " The catalog itself carries a verified signature."
                : ""}
            </p>
          </Card>

          <Sect title="Choose your device" />
          <div className="dl-grid">
            {ordered.map((platform) => (
              <PlatformCard
                key={platform}
                platform={platform}
                entry={byPlatform.get(platform)}
                recommended={platform === detected}
              />
            ))}
          </div>

          <Sect title="After you install" />
          <Card>
            <p className="dl-note">
              Open the app and pair it with this box — you&apos;ll need a
              pairing code.{" "}
              <Link href="/devices/pair">Create a pairing code →</Link>
            </p>
          </Card>
        </>
      )}
    </ShellPage>
  );
}
