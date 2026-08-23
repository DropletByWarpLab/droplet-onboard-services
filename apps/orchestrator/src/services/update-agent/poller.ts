/**
 * WARP-538 — update-agent poller: discover, verify, schedule (no apply).
 *
 * `checkForUpdate()` is the 15-minute tick (wired in index.ts through
 * cron-runtime `scheduleInterval` — no `while (true)`, per CLAUDE.md):
 *
 *   1. Discover the newest release FOR THIS BOX'S CHANNEL (WARP-1670).
 *      `stable` GETs the GitHub Releases `latest` endpoint
 *      (deployment-configured via DROPLET_OTA_RELEASES_URL;
 *      DROPLET_OTA_GITHUB_TOKEN for the private repo). Every other
 *      channel lists releases and takes the newest tagged
 *      `ota-<channel>-*`, because `latest` deliberately skips the
 *      prereleases that non-stable channels publish as.
 *   2. Download the `release.json` + `release.json.sig` assets to a
 *      temp dir.
 *   3. Run the full WARP-537 trust chain (`verifyAndParseRelease`):
 *      trust anchor → cosign signature → schema. A verification failure
 *      writes NO DeviceUpdate row — only an `update.signature_failed` /
 *      `update.verify_failed` log event. Unverified data never touches
 *      the database.
 *   4. Refuse releases from a different channel than the device's
 *      persisted setting. This gate survives step 1's channel-aware
 *      discovery on purpose: discovery filters on the TAG, which is
 *      unsigned repo metadata, while this compares the channel inside
 *      the cosign-verified manifest. Only the second one is trust.
 *   5. If the release's gitSha is already tracked (any status) — no-op:
 *      the table is append-only and one row per release is the
 *      invariant.
 *   6. Otherwise, in one transaction: flip every prior `pending` row to
 *      `superseded`, then insert the new `pending` row snapshotting the
 *      verified manifest (`manifestJson`) + its sha256. The apply step
 *      (WARP-539) acts on that snapshot, not a re-fetch — no
 *      verify/use TOCTOU window.
 *
 * `runApplyWindow()` is the 03:00 window tick. WARP-538 ships it as an
 * HONEST stub: it logs the pending release + the autoApply setting and
 * takes no action (it does NOT advance status — faking `applying` rows
 * before WARP-539 exists would poison the audit table).
 *
 * Concurrency: both ticks run under cron-runtime advisory locks
 * (droplet:update-agent.poll / droplet:update-agent.apply-window), so
 * multi-instance deploys single-fire. Within one instance the poll tick
 * is the only DeviceUpdate writer until WARP-539.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";
import { verifyAndParseRelease } from "./verify.js";
import type { UpdateFailureReason } from "./manifest.js";
import { getUpdateAgentSettings } from "./settings.js";
import { supersedePendingUpdates } from "./transitions.js";

const defaultLog = createLogger("update-agent");

/** The slice of a GitHub Release the poller reads. */
interface GithubReleaseAsset {
  name: string;
  /** API asset URL — download with Accept: application/octet-stream. */
  url: string;
}
interface GithubLatestRelease {
  tag_name?: string;
  assets?: GithubReleaseAsset[];
}

export interface CheckForUpdateOptions {
  prisma: PrismaClient;
  /** GitHub Releases `latest` endpoint (config.DROPLET_OTA_RELEASES_URL). */
  releasesLatestUrl: string;
  /**
   * WARP-1670 — the releases LIST endpoint, used by non-stable channels.
   * Optional: derived from `releasesLatestUrl` when omitted (that is the
   * production path — one .env knob, not two). Set it explicitly for
   * mirrors, or for tests that serve a fake releases list.
   */
  releasesListUrl?: string;
  /** Token for private-repo access; omit for unauthenticated (tests). */
  githubToken?: string;
  fetchImpl?: typeof fetch;
  logger?: pino.Logger;
  /** Trust-anchor override — tests only (golden-fixture key). */
  publicKeyPath?: string;
  /** Cosign binary override — tests only. */
  cosignBin?: string;
}

/**
 * How deep to look for a channel's newest release. GitHub returns
 * releases newest-first, and stable publishes interleave with stage
 * ones, so this is "how many releases back a stage box will still find
 * its build" — one page is many weeks at any realistic cadence, and
 * bounding it keeps a poll to a single request.
 */
const RELEASES_LIST_PAGE_SIZE = 30;

/**
 * `…/releases/latest` → `…/releases?per_page=<n>`.
 *
 * Returns null when the configured URL is not a `latest` endpoint (a
 * file-served test fake, say). Callers must treat that as "cannot
 * discover for this channel" and say so — never as "no release", which
 * would silently park a stage box on nothing forever.
 */
export function deriveReleasesListUrl(
  releasesLatestUrl: string,
  perPage = RELEASES_LIST_PAGE_SIZE,
): string | null {
  let url: URL;
  try {
    url = new URL(releasesLatestUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/releases/latest")) return null;
  url.pathname = url.pathname.slice(0, -"/latest".length);
  url.search = `?per_page=${perPage}`;
  return url.toString();
}

/** The tag prefix a channel's releases carry (publish-release.yml). */
export function channelTagPrefix(channel: string): string {
  return `ota-${channel}-`;
}

export type CheckForUpdateResult =
  | { outcome: "no_release" }
  /**
   * WARP-2133 — the releases endpoint 404'd and this box has NO
   * DROPLET_OTA_GITHUB_TOKEN. GitHub answers 404 for a private repo
   * whether or not releases exist when the request is unauthenticated,
   * so a token-less box cannot distinguish "no release" from "no
   * access". Distinct from no_release so nothing upstream paints an
   * unprovisioned box as up to date.
   */
  | { outcome: "source_unauthenticated"; detail: string }
  | { outcome: "fetch_failed"; detail: string }
  | { outcome: "verify_failed"; failureReason: UpdateFailureReason; detail: string }
  | { outcome: "channel_mismatch"; releaseChannel: string; deviceChannel: string }
  | { outcome: "already_known"; gitSha: string }
  | {
      outcome: "pending_created";
      deviceUpdateId: string;
      gitSha: string;
      supersededCount: number;
    };

async function downloadAsset(
  fetchImpl: typeof fetch,
  asset: GithubReleaseAsset,
  githubToken: string | undefined,
): Promise<Buffer> {
  const res = await fetchImpl(asset.url, {
    headers: {
      accept: "application/octet-stream",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`asset ${asset.name} download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * WARP-2133 — shared honesty gate for a 404 from either releases
 * endpoint. Unauthenticated, a private repo's releases endpoints 404
 * regardless of whether releases exist, so without a token a 404 means
 * "this box cannot see its update source", not "no release". Returns
 * the typed outcome to relay, or null when the 404 is trustworthy
 * (a token was sent — the repo is visible and genuinely empty).
 */
function unauthenticated404(
  githubToken: string | undefined,
  log: pino.Logger,
  endpoint: "latest" | "list",
): Extract<CheckForUpdateResult, { outcome: "source_unauthenticated" }> | null {
  if (githubToken) return null;
  const detail =
    `releases ${endpoint} endpoint returned 404 with no DROPLET_OTA_GITHUB_TOKEN configured — ` +
    "this box cannot see its update source, so no update would ever be found";
  log.warn(
    { event: "update.source_unauthenticated", detail },
    "OTA update source is not provisioned on this box",
  );
  return { outcome: "source_unauthenticated", detail };
}

/**
 * One poll tick. Never throws for expected failure shapes — every exit
 * is a typed outcome plus a structured `update.*` log event, so the
 * cron wrapper's error path is reserved for genuine bugs.
 */
export async function checkForUpdate(
  opts: CheckForUpdateOptions,
): Promise<CheckForUpdateResult> {
  const log = opts.logger ?? defaultLog;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Every-15-minutes chatter — debug, not info (WARP-541 level convention).
  log.debug?.({ event: "update.check_started" }, "OTA release check started");

  // The channel is read BEFORE discovery (WARP-1670): it selects which
  // endpoint to ask, not just which answer to accept.
  const settings = await getUpdateAgentSettings(opts.prisma);
  const headers = {
    accept: "application/vnd.github+json",
    ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
  };

  // ── 1. discover the newest release for this box's channel ──
  let release: GithubLatestRelease;
  if (settings.channel === "stable") {
    // `latest` skips prereleases, so it already means "newest stable".
    try {
      const res = await fetchImpl(opts.releasesLatestUrl, { headers });
      if (res.status === 404) {
        // WARP-2133: without a token this 404 is "cannot see the source",
        // not "no release" — say so loudly instead of implying up-to-date.
        const unprovisioned = unauthenticated404(opts.githubToken, log, "latest");
        if (unprovisioned) return unprovisioned;
        // Authenticated 404: no release published yet — normal on a
        // fresh repo, debug only.
        log.debug?.({ event: "update.no_release" }, "no OTA release published yet");
        return { outcome: "no_release" };
      }
      if (!res.ok) {
        const detail = `releases latest endpoint returned HTTP ${res.status}`;
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { outcome: "fetch_failed", detail };
      }
      release = (await res.json()) as GithubLatestRelease;
    } catch (err) {
      const detail = `releases latest endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { outcome: "fetch_failed", detail };
    }
  } else {
    const listUrl =
      opts.releasesListUrl ?? deriveReleasesListUrl(opts.releasesLatestUrl);
    if (!listUrl) {
      // Misconfiguration, not absence: say so loudly rather than reporting
      // "no release" every 15 minutes on a box that can never find one.
      const detail = `channel ${settings.channel} needs a releases list endpoint, and none could be derived from ${opts.releasesLatestUrl}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { outcome: "fetch_failed", detail };
    }
    let listed: GithubLatestRelease[];
    try {
      const res = await fetchImpl(listUrl, { headers });
      if (res.status === 404) {
        // WARP-2133: same honesty gate as the stable path — a token-less
        // 404 here is an unprovisioned source, not an unreachable feed.
        const unprovisioned = unauthenticated404(opts.githubToken, log, "list");
        if (unprovisioned) return unprovisioned;
      }
      if (!res.ok) {
        const detail = `releases list endpoint returned HTTP ${res.status}`;
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { outcome: "fetch_failed", detail };
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        const detail = "releases list endpoint did not return an array";
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { outcome: "fetch_failed", detail };
      }
      listed = body as GithubLatestRelease[];
    } catch (err) {
      const detail = `releases list endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { outcome: "fetch_failed", detail };
    }
    // GitHub returns releases newest-first. The tag prefix is a cheap
    // pre-filter over UNSIGNED metadata — a release that lies in its tag
    // still has to pass the manifest channel gate in step 4 below.
    const prefix = channelTagPrefix(settings.channel);
    const match = listed.find((r) => (r.tag_name ?? "").startsWith(prefix));
    if (!match) {
      log.debug?.(
        { event: "update.no_release", channel: settings.channel },
        "no OTA release published yet for this channel",
      );
      return { outcome: "no_release" };
    }
    release = match;
  }

  const assets = release.assets ?? [];
  const manifestAsset = assets.find((a) => a.name === "release.json");
  const sigAsset = assets.find((a) => a.name === "release.json.sig");
  if (!manifestAsset || !sigAsset) {
    const detail = `release ${release.tag_name ?? "(untagged)"} is missing release.json/.sig assets`;
    log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
    return { outcome: "fetch_failed", detail };
  }

  // ── 2 + 3. download to a temp dir, run the WARP-537 trust chain ──
  const workDir = await mkdtemp(path.join(tmpdir(), "droplet-ota-"));
  try {
    let manifestBytes: Buffer;
    let sigBytes: Buffer;
    try {
      manifestBytes = await downloadAsset(fetchImpl, manifestAsset, opts.githubToken);
      sigBytes = await downloadAsset(fetchImpl, sigAsset, opts.githubToken);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { outcome: "fetch_failed", detail };
    }

    const manifestPath = path.join(workDir, "release.json");
    const signaturePath = path.join(workDir, "release.json.sig");
    await writeFile(manifestPath, manifestBytes);
    await writeFile(signaturePath, sigBytes);

    const verified = await verifyAndParseRelease({
      manifestPath,
      signaturePath,
      publicKeyPath: opts.publicKeyPath,
      cosignBin: opts.cosignBin,
    });
    if (!verified.ok) {
      // A failed verification writes NO row (WARP-538 AC). The event name
      // distinguishes the cryptographic refusal from schema refusals so
      // alerting can treat tampering as its own signal.
      const event =
        verified.failureReason === "signature_failed"
          ? "update.signature_failed"
          : "update.verify_failed";
      log.warn(
        {
          event,
          failureReason: verified.failureReason,
          detail: verified.detail,
          releaseTag: release.tag_name,
        },
        "OTA release failed verification — no DeviceUpdate row written",
      );
      return {
        outcome: "verify_failed",
        failureReason: verified.failureReason,
        detail: verified.detail,
      };
    }
    const manifest = verified.manifest;
    // Debug: on a healthy box this fires every poll once a release exists
    // (`update.pending_created` is the info-level "verified AND now
    // tracked" event; this one exists so a failing channel/known gate is
    // still attributable to a manifest that DID verify).
    log.debug?.(
      {
        event: "update.manifest_verified",
        gitSha: manifest.release.gitSha,
        releaseTag: release.tag_name,
        channel: manifest.release.channel,
      },
      "OTA release manifest passed the trust chain",
    );

    // ── 4. channel gate ──
    // Re-checked against the SIGNED manifest even though discovery already
    // filtered on the tag: the tag is repo metadata anyone with write access
    // can set, the manifest field is covered by the cosign signature.
    if (manifest.release.channel !== settings.channel) {
      log.warn(
        {
          event: "update.channel_mismatch",
          releaseChannel: manifest.release.channel,
          deviceChannel: settings.channel,
          releaseTag: release.tag_name,
        },
        "OTA release is for a different channel — ignored",
      );
      return {
        outcome: "channel_mismatch",
        releaseChannel: manifest.release.channel,
        deviceChannel: settings.channel,
      };
    }

    // ── 5. one row per release (append-only table) ──
    const gitSha = manifest.release.gitSha;
    const existing = await opts.prisma.deviceUpdate.findFirst({
      where: { gitSha },
      select: { id: true, status: true },
    });
    if (existing) {
      log.debug?.(
        { event: "update.already_known", gitSha, status: existing.status },
        "latest OTA release is already tracked",
      );
      return { outcome: "already_known", gitSha };
    }

    // ── 6. supersede prior pending + insert the new pending row ──
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const { supersededCount, created } = await opts.prisma.$transaction(
      async (tx) => {
        // WARP-541: through the advance-only choke point (transitions.ts)
        // — only `pending` rows can ever become `superseded`.
        const superseded = await supersedePendingUpdates(tx, log);
        const row = await tx.deviceUpdate.create({
          data: {
            status: "pending",
            channel: manifest.release.channel,
            releaseTag: release.tag_name ?? null,
            gitSha,
            builtAt: new Date(manifest.release.builtAt),
            manifestSha256,
            // The verified manifest snapshot WARP-539 applies from.
            manifestJson: manifest,
          },
        });
        return { supersededCount: superseded, created: row };
      },
    );

    log.info(
      {
        event: "update.pending_created",
        deviceUpdateId: created.id,
        gitSha,
        releaseTag: release.tag_name,
        supersededCount,
      },
      "new OTA release verified — pending DeviceUpdate row created",
    );
    return {
      outcome: "pending_created",
      deviceUpdateId: created.id,
      gitSha,
      supersededCount,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 03:00 maintenance-window tick — WARP-539 STUB. Reports what WOULD
 * happen and deliberately does not advance any status: the state machine
 * is advance-only and `applying` must mean an apply actually started.
 */
export async function runApplyWindow(
  prisma: PrismaClient,
  logger: pino.Logger = defaultLog,
): Promise<void> {
  const pending = await prisma.deviceUpdate.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    select: { id: true, gitSha: true, releaseTag: true },
  });
  if (!pending) return;
  const settings = await getUpdateAgentSettings(prisma);
  logger.info(
    {
      event: "update.apply_window",
      deviceUpdateId: pending.id,
      gitSha: pending.gitSha,
      releaseTag: pending.releaseTag,
      autoApply: settings.autoApply,
    },
    "apply window reached with a pending update — apply/health-gate/rollback lands in WARP-539; no action taken",
  );
}
