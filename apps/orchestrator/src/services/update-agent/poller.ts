/**
 * WARP-538 — update-agent poller: discover, verify, schedule (no apply).
 *
 * `checkForUpdate()` is the 15-minute tick (wired in index.ts through
 * cron-runtime `scheduleInterval` — no `while (true)`, per CLAUDE.md):
 *
 *   1. GET the GitHub Releases `latest` endpoint (deployment-configured
 *      via DROPLET_OTA_RELEASES_URL; DROPLET_OTA_GITHUB_TOKEN for the
 *      private repo).
 *   2. Download the `release.json` + `release.json.sig` assets to a
 *      temp dir.
 *   3. Run the full WARP-537 trust chain (`verifyAndParseRelease`):
 *      trust anchor → cosign signature → schema. A verification failure
 *      writes NO DeviceUpdate row — only an `update.signature_failed` /
 *      `update.verify_failed` log event. Unverified data never touches
 *      the database.
 *   4. Refuse releases from a different channel than the device's
 *      persisted setting (single `stable` channel today).
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
  /** Token for private-repo access; omit for unauthenticated (tests). */
  githubToken?: string;
  fetchImpl?: typeof fetch;
  logger?: pino.Logger;
  /** Trust-anchor override — tests only (golden-fixture key). */
  publicKeyPath?: string;
  /** Cosign binary override — tests only. */
  cosignBin?: string;
}

export type CheckForUpdateResult =
  | { outcome: "no_release" }
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
 * One poll tick. Never throws for expected failure shapes — every exit
 * is a typed outcome plus a structured `update.*` log event, so the
 * cron wrapper's error path is reserved for genuine bugs.
 */
export async function checkForUpdate(
  opts: CheckForUpdateOptions,
): Promise<CheckForUpdateResult> {
  const log = opts.logger ?? defaultLog;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // ── 1. discover the latest release ──
  let release: GithubLatestRelease;
  try {
    const res = await fetchImpl(opts.releasesLatestUrl, {
      headers: {
        accept: "application/vnd.github+json",
        ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
      },
    });
    if (res.status === 404) {
      // No release published yet — normal on a fresh repo, debug only.
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

    // ── 4. channel gate ──
    const settings = await getUpdateAgentSettings(opts.prisma);
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
        const superseded = await tx.deviceUpdate.updateMany({
          where: { status: "pending" },
          data: { status: "superseded" },
        });
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
        return { supersededCount: superseded.count, created: row };
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
