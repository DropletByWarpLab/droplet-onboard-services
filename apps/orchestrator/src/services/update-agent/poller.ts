/**
 * WARP-538 — update-agent poller: discover, verify, schedule (no apply).
 *
 * `checkForUpdate()` is the 15-minute tick (wired in index.ts through
 * cron-runtime `scheduleInterval` — no `while (true)`, per CLAUDE.md):
 *
 *   1. Discover the newest release FOR THIS BOX'S CHANNEL, anonymously
 *      (WARP-3430). The box downloads the cosign-signed channel pointer
 *      `<download base>/ota-index/channel-<channel>.json` (channel-pointer.ts),
 *      verifies it exactly like the manifest, and follows its `tag` to
 *      `<download base>/<tag>/release.json`. Those are plain file downloads —
 *      no GitHub REST API, no token (ADR-045), so no 60-requests-an-hour cap
 *      for boxes behind one NAT. Only a pointer that does not exist yet (HTTP
 *      404: the publisher has not emitted an index) falls back to the legacy
 *      GitHub API discovery below; any other pointer failure is
 *      `fetch_failed`, never a silent downgrade to the API.
 *      LEGACY (WARP-1670): `stable` GETs the GitHub Releases `latest`
 *      endpoint (DROPLET_OTA_RELEASES_URL; DROPLET_OTA_GITHUB_TOKEN is
 *      lab/dev only). Every other channel lists releases and takes the newest
 *      tagged `ota-<channel>-*`, because `latest` deliberately skips the
 *      prereleases that non-stable channels publish as.
 *   2. Download the `release.json` + `release.json.sig` assets to a
 *      temp dir.
 *   3. Run the full WARP-537 trust chain (`verifyAndParseRelease`):
 *      trust anchor → cosign signature → schema. A verification failure
 *      writes NO DeviceUpdate row — only an `update.signature_failed` /
 *      `update.verify_failed` log event. Unverified data never touches
 *      the database. When the pointer named the release, the manifest's
 *      sha256 (and gitSha, builtAt) must also equal what the signed pointer
 *      attests: a pointer and a manifest that disagree are both refused.
 *   4. Refuse releases from a different channel than the device's
 *      persisted setting. This gate survives step 1's channel-aware
 *      discovery on purpose: discovery filters on the TAG, which is
 *      unsigned repo metadata, while this compares the channel inside
 *      the cosign-verified manifest. Only the second one is trust.
 *   5. If the release's gitSha is already tracked (any status) — no-op:
 *      the table is append-only and one row per release is the
 *      invariant.
 *   5b. Never go backwards (WARP-3430): a release whose signed `builtAt` is
 *      not strictly newer than the installed one (the newest `committed`
 *      row — the same read health-monitor uses for the box's version) is
 *      `not_newer` and writes no row. A replayed older pointer, signed and
 *      genuine, would otherwise roll a box back. No committed row (a locally
 *      built box) means no floor. apply.ts re-checks the same floor before
 *      any side effect: a row can sit parked (`verifying`) past a newer commit.
 *   6. Otherwise, in one transaction: flip every prior `pending` row — and
 *      every unclaimed, parked `verifying` row (WARP-3430) — to
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
import { parseChannelPointer, type ChannelPointer } from "./channel-pointer.js";
import { channelPointerUrl, releaseAssetDownloadUrl } from "./download-urls.js";
import { verifyAndParseRelease, verifySignedBytes } from "./verify.js";
import type { ReleaseManifest, UpdateFailureReason } from "./manifest.js";
import { getUpdateAgentSettings } from "./settings.js";
import {
  installedRelease,
  supersedePendingUpdates,
  supersedeUnclaimedVerifyingUpdates,
} from "./transitions.js";

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
  /**
   * GitHub Releases `latest` endpoint (config.DROPLET_OTA_RELEASES_URL). Since
   * WARP-3430 only the FALLBACK discovery path uses it: a box asks the signed
   * channel pointer first and reaches for the API only while no pointer is
   * published (HTTP 404).
   */
  releasesLatestUrl: string;
  /**
   * WARP-1670 — the releases LIST endpoint, used by non-stable channels.
   * Optional: derived from `releasesLatestUrl` when omitted (that is the
   * production path — one .env knob, not two). Set it explicitly for
   * mirrors, or for tests that serve a fake releases list.
   */
  releasesListUrl?: string;
  /**
   * WARP-3430 — base of the anonymous release downloads
   * (config.DROPLET_OTA_DOWNLOAD_BASE): the signed channel pointer lives at
   * `<base>/ota-index/channel-<channel>.json`, a release's assets at
   * `<base>/<tag>/<name>` (download-urls.ts). Required, so a caller that
   * forgets to wire it fails `tsc` instead of silently polling the API.
   */
  downloadBase: string;
  /**
   * Bearer for a private repo — LAB/DEV ONLY. ADR-045: no token is ever
   * provisioned on an appliance, and the pointer path needs none. Omit for
   * unauthenticated (production, tests).
   */
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
  | { outcome: "fetch_failed"; detail: string }
  | { outcome: "verify_failed"; failureReason: UpdateFailureReason; detail: string }
  | { outcome: "channel_mismatch"; releaseChannel: string; deviceChannel: string }
  | { outcome: "already_known"; gitSha: string }
  /** WARP-3430 — a verified release not strictly newer than the installed one; no row written. */
  | { outcome: "not_newer"; gitSha: string; builtAt: string; installedBuiltAt: string }
  | {
      outcome: "pending_created";
      deviceUpdateId: string;
      gitSha: string;
      supersededCount: number;
    };

/** An HTTP answer that was not 2xx — callers tell 404 (not published) from the rest. */
class DownloadStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DownloadStatusError";
  }
}

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
    throw new DownloadStatusError(res.status, `asset ${asset.name} download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** What discovery hands the trust chain: the release's bytes, or a final answer. */
type Discovery =
  | {
      found: true;
      /** The release tag — unsigned repo metadata, a hint and a URL segment, never a trust decision. */
      tag: string | undefined;
      manifestBytes: Buffer;
      sigBytes: Buffer;
      /** Set when the signed channel pointer named this release (it must then agree with the manifest). */
      pointer: ChannelPointer | null;
    }
  | { found: false; result: CheckForUpdateResult };

interface DiscoveryContext {
  opts: CheckForUpdateOptions;
  channel: string;
  workDir: string;
  log: pino.Logger;
  fetchImpl: typeof fetch;
}

function fetchFailed(log: pino.Logger, detail: string): Discovery {
  log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
  return { found: false, result: { outcome: "fetch_failed", detail } };
}

/**
 * A verification failure writes NO row (WARP-538 AC). The event name
 * distinguishes the cryptographic refusal from schema refusals so alerting
 * can treat tampering as its own signal.
 */
function verifyFailed(
  log: pino.Logger,
  failure: { failureReason: UpdateFailureReason; detail: string },
  ctx: { document: "channel_pointer" | "release_manifest"; releaseTag?: string },
): CheckForUpdateResult {
  const event =
    failure.failureReason === "signature_failed"
      ? "update.signature_failed"
      : "update.verify_failed";
  log.warn(
    {
      event,
      failureReason: failure.failureReason,
      detail: failure.detail,
      document: ctx.document,
      releaseTag: ctx.releaseTag,
    },
    "OTA release failed verification — no DeviceUpdate row written",
  );
  return {
    outcome: "verify_failed",
    failureReason: failure.failureReason,
    detail: failure.detail,
  };
}

/**
 * WARP-3430 — discovery through the signed channel pointer. Returns null ONLY
 * for HTTP 404 on the pointer (no index published yet): the caller then runs
 * the legacy API discovery. Every other outcome is final.
 */
async function discoverViaChannelPointer(ctx: DiscoveryContext): Promise<Discovery | null> {
  const { opts, channel, workDir, log, fetchImpl } = ctx;
  const pointerUrl = channelPointerUrl(opts.downloadBase, channel);

  let pointerBytes: Buffer;
  try {
    pointerBytes = await downloadAsset(
      fetchImpl,
      { name: `channel-${channel}.json`, url: pointerUrl },
      opts.githubToken,
    );
  } catch (err) {
    if (err instanceof DownloadStatusError && err.status === 404) {
      // Normal until the publisher emits an index. Debug: it repeats every tick.
      log.debug?.(
        { event: "update.pointer_unavailable", channel },
        "no channel pointer published yet — falling back to the releases API",
      );
      return null;
    }
    return fetchFailed(log, `channel pointer unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  let pointerSigBytes: Buffer;
  try {
    pointerSigBytes = await downloadAsset(
      fetchImpl,
      { name: `channel-${channel}.json.sig`, url: `${pointerUrl}.sig` },
      opts.githubToken,
    );
  } catch (err) {
    // A pointer without its signature is a half-published index, not an absent one.
    return fetchFailed(log, `channel pointer signature unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pointerPath = path.join(workDir, "channel-pointer.json");
  const pointerSigPath = path.join(workDir, "channel-pointer.json.sig");
  await writeFile(pointerPath, pointerBytes);
  await writeFile(pointerSigPath, pointerSigBytes);

  // The same trust anchor and code path as the manifest (verify.ts).
  const signed = await verifySignedBytes({
    manifestPath: pointerPath,
    signaturePath: pointerSigPath,
    publicKeyPath: opts.publicKeyPath,
    cosignBin: opts.cosignBin,
  });
  if (!signed.ok) {
    return { found: false, result: verifyFailed(log, signed, { document: "channel_pointer" }) };
  }
  const parsed = parseChannelPointer(signed.raw);
  if (!parsed.ok) {
    return { found: false, result: verifyFailed(log, parsed, { document: "channel_pointer" }) };
  }
  const pointer = parsed.pointer;

  if (pointer.channel !== channel) {
    log.warn(
      {
        event: "update.channel_mismatch",
        releaseChannel: pointer.channel,
        deviceChannel: channel,
        releaseTag: pointer.tag,
      },
      "OTA channel pointer is for a different channel — ignored",
    );
    return {
      found: false,
      result: { outcome: "channel_mismatch", releaseChannel: pointer.channel, deviceChannel: channel },
    };
  }

  // The tag came out of a signed, schema-checked pointer; the release's own
  // files are plain downloads under it.
  try {
    const manifestBytes = await downloadAsset(
      fetchImpl,
      { name: "release.json", url: releaseAssetDownloadUrl(opts.downloadBase, pointer.tag, "release.json") },
      opts.githubToken,
    );
    const sigBytes = await downloadAsset(
      fetchImpl,
      { name: "release.json.sig", url: releaseAssetDownloadUrl(opts.downloadBase, pointer.tag, "release.json.sig") },
      opts.githubToken,
    );
    return { found: true, tag: pointer.tag, manifestBytes, sigBytes, pointer };
  } catch (err) {
    // Includes a 404: the signed pointer names a release whose files are not
    // there, which is a broken publish, not an absent index.
    return fetchFailed(log, err instanceof Error ? err.message : String(err));
  }
}

/**
 * LEGACY discovery (WARP-538 / WARP-1670), unchanged: GitHub REST API —
 * `latest` for stable, the releases list filtered on the tag prefix for any
 * other channel — then the release's asset downloads.
 */
async function discoverViaReleasesApi(ctx: DiscoveryContext): Promise<Discovery> {
  const { opts, channel, log, fetchImpl } = ctx;
  const headers = {
    accept: "application/vnd.github+json",
    ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
  };

  let release: GithubLatestRelease;
  if (channel === "stable") {
    // `latest` skips prereleases, so it already means "newest stable".
    try {
      const res = await fetchImpl(opts.releasesLatestUrl, { headers });
      if (res.status === 404) {
        // No release published yet — normal on a fresh repo, debug only.
        log.debug?.({ event: "update.no_release" }, "no OTA release published yet");
        return { found: false, result: { outcome: "no_release" } };
      }
      if (!res.ok) {
        const detail = `releases latest endpoint returned HTTP ${res.status}`;
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { found: false, result: { outcome: "fetch_failed", detail } };
      }
      release = (await res.json()) as GithubLatestRelease;
    } catch (err) {
      const detail = `releases latest endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { found: false, result: { outcome: "fetch_failed", detail } };
    }
  } else {
    const listUrl =
      opts.releasesListUrl ?? deriveReleasesListUrl(opts.releasesLatestUrl);
    if (!listUrl) {
      // Misconfiguration, not absence: say so loudly rather than reporting
      // "no release" every 15 minutes on a box that can never find one.
      const detail = `channel ${channel} needs a releases list endpoint, and none could be derived from ${opts.releasesLatestUrl}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { found: false, result: { outcome: "fetch_failed", detail } };
    }
    let listed: GithubLatestRelease[];
    try {
      const res = await fetchImpl(listUrl, { headers });
      if (!res.ok) {
        const detail = `releases list endpoint returned HTTP ${res.status}`;
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { found: false, result: { outcome: "fetch_failed", detail } };
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        const detail = "releases list endpoint did not return an array";
        log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
        return { found: false, result: { outcome: "fetch_failed", detail } };
      }
      listed = body as GithubLatestRelease[];
    } catch (err) {
      const detail = `releases list endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
      return { found: false, result: { outcome: "fetch_failed", detail } };
    }
    // GitHub returns releases newest-first. The tag prefix is a cheap
    // pre-filter over UNSIGNED metadata — a release that lies in its tag
    // still has to pass the manifest channel gate in step 4 below.
    const prefix = channelTagPrefix(channel);
    const match = listed.find((r) => (r.tag_name ?? "").startsWith(prefix));
    if (!match) {
      log.debug?.(
        { event: "update.no_release", channel },
        "no OTA release published yet for this channel",
      );
      return { found: false, result: { outcome: "no_release" } };
    }
    release = match;
  }

  const assets = release.assets ?? [];
  const manifestAsset = assets.find((a) => a.name === "release.json");
  const sigAsset = assets.find((a) => a.name === "release.json.sig");
  if (!manifestAsset || !sigAsset) {
    const detail = `release ${release.tag_name ?? "(untagged)"} is missing release.json/.sig assets`;
    log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
    return { found: false, result: { outcome: "fetch_failed", detail } };
  }

  try {
    const manifestBytes = await downloadAsset(fetchImpl, manifestAsset, opts.githubToken);
    const sigBytes = await downloadAsset(fetchImpl, sigAsset, opts.githubToken);
    return { found: true, tag: release.tag_name, manifestBytes, sigBytes, pointer: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ event: "update.check_failed", detail }, "OTA release check failed");
    return { found: false, result: { outcome: "fetch_failed", detail } };
  }
}

/**
 * The signed pointer vouches for the manifest it names: same bytes, same
 * commit, same build time. Null = they agree; otherwise what differs.
 */
function pointerDisagreement(
  pointer: ChannelPointer,
  manifest: ReleaseManifest,
  manifestSha256: string,
): string | null {
  if (manifestSha256 !== pointer.manifestSha256) {
    return `release.json sha256 ${manifestSha256} != pointer ${pointer.manifestSha256}`;
  }
  if (manifest.release.gitSha !== pointer.gitSha) {
    return `manifest gitSha ${manifest.release.gitSha} != pointer ${pointer.gitSha}`;
  }
  if (Date.parse(manifest.release.builtAt) !== Date.parse(pointer.builtAt)) {
    return `manifest builtAt ${manifest.release.builtAt} != pointer ${pointer.builtAt}`;
  }
  return null;
}

/**
 * WARP-3504 — observers of every completed check (the 15-minute poll and
 * check-now alike), for the box telemetry sender. Best-effort by contract: an
 * observer that throws is swallowed.
 */
const checkObservers = new Set<(result: CheckForUpdateResult) => void>();

/** Subscribe to every future check outcome. Returns an unsubscribe. */
export function onUpdateCheck(observer: (result: CheckForUpdateResult) => void): () => void {
  checkObservers.add(observer);
  return () => {
    checkObservers.delete(observer);
  };
}

/**
 * One poll tick. Never throws for expected failure shapes — every exit
 * is a typed outcome plus a structured `update.*` log event, so the
 * cron wrapper's error path is reserved for genuine bugs.
 */
export async function checkForUpdate(
  opts: CheckForUpdateOptions,
): Promise<CheckForUpdateResult> {
  const result = await runCheck(opts);
  for (const observe of checkObservers) {
    try {
      observe(result);
    } catch {
      // Observers are best-effort by contract.
    }
  }
  return result;
}

async function runCheck(
  opts: CheckForUpdateOptions,
): Promise<CheckForUpdateResult> {
  const log = opts.logger ?? defaultLog;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Every-15-minutes chatter — debug, not info (WARP-541 level convention).
  log.debug?.({ event: "update.check_started" }, "OTA release check started");

  // The channel is read BEFORE discovery (WARP-1670): it selects which
  // endpoint to ask, not just which answer to accept.
  const settings = await getUpdateAgentSettings(opts.prisma);

  // The pointer's own signature check needs a scratch dir before the
  // manifest's would, so one dir serves the whole tick.
  const workDir = await mkdtemp(path.join(tmpdir(), "droplet-ota-"));
  try {
    // ── 1. discover the newest release for this box's channel ──
    const ctx: DiscoveryContext = { opts, channel: settings.channel, workDir, log, fetchImpl };
    const discovered = (await discoverViaChannelPointer(ctx)) ?? (await discoverViaReleasesApi(ctx));
    if (!discovered.found) return discovered.result;
    const { tag, manifestBytes, sigBytes, pointer } = discovered;

    // ── 2 + 3. write to the temp dir, run the WARP-537 trust chain ──
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
      return verifyFailed(log, verified, { document: "release_manifest", releaseTag: tag });
    }
    const manifest = verified.manifest;
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

    // The pointer is signed, so its claims are as good as the manifest's —
    // and they must be the SAME claims. A replayed old manifest under a new
    // pointer (or the reverse) is refused here, as its own reason.
    if (pointer) {
      const detail = pointerDisagreement(pointer, manifest, manifestSha256);
      if (detail !== null) {
        return verifyFailed(
          log,
          { failureReason: "pointer_mismatch", detail },
          { document: "release_manifest", releaseTag: tag },
        );
      }
    }
    // Debug: on a healthy box this fires every poll once a release exists
    // (`update.pending_created` is the info-level "verified AND now
    // tracked" event; this one exists so a failing channel/known gate is
    // still attributable to a manifest that DID verify).
    log.debug?.(
      {
        event: "update.manifest_verified",
        gitSha: manifest.release.gitSha,
        releaseTag: tag,
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
          releaseTag: tag,
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

    // ── 5b. never go backwards (WARP-3430) ──
    // After the known-check, so the release already installed stays
    // `already_known`. The floor is the newest COMMITTED row — what
    // health-monitor reports as the box's version and routes/updates.ts as
    // "currently running" — compared on the SIGNED builtAt. Equal is not
    // newer: two different commits claiming one build instant cannot be
    // ordered, so neither replaces the other. apply.ts re-checks the same
    // floor (installedRelease) before it touches anything, because a row
    // created here can wait, parked, until a newer release has committed.
    const installed = await installedRelease(opts.prisma);
    const builtAt = new Date(manifest.release.builtAt);
    if (installed && builtAt.getTime() <= installed.builtAt.getTime()) {
      // Debug, not warn: in steady state this repeats every tick (a box whose
      // channel's pointer is behind what it runs). The refusal is the outcome.
      log.debug?.(
        {
          event: "update.not_newer",
          gitSha,
          releaseTag: tag,
          builtAt: builtAt.toISOString(),
          installedGitSha: installed.gitSha,
          installedBuiltAt: installed.builtAt.toISOString(),
        },
        "OTA release is not newer than the installed one — ignored, no DeviceUpdate row written",
      );
      return {
        outcome: "not_newer",
        gitSha,
        builtAt: builtAt.toISOString(),
        installedBuiltAt: installed.builtAt.toISOString(),
      };
    }

    // ── 6. supersede prior pending + parked rows, insert the new pending row ──
    const { supersededCount, created } = await opts.prisma.$transaction(
      async (tx) => {
        // WARP-541: through the advance-only choke point (transitions.ts)
        // — only `pending` rows can ever become `superseded`.
        // WARP-3430: and UNCLAIMED `verifying` rows — parked by a transient
        // failure (registry-auth retries make that routine). Every apply path
        // picks the newest pending|verifying row, so an older parked row left
        // in place would be applied after this release: a downgrade. A
        // CLAIMED row is mid-apply and is left alone.
        const superseded =
          (await supersedePendingUpdates(tx, log)) +
          (await supersedeUnclaimedVerifyingUpdates(tx, log));
        const row = await tx.deviceUpdate.create({
          data: {
            status: "pending",
            channel: manifest.release.channel,
            releaseTag: tag ?? null,
            gitSha,
            builtAt,
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
        releaseTag: tag,
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
