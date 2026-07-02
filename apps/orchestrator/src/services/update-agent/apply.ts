/**
 * WARP-539 — apply + health-gated swap + auto-rollback (the OTA critical
 * path). Consumes the `pending` DeviceUpdate row the WARP-538 poller
 * created (its manifestJson snapshot IS the verified contract — no
 * re-fetch, no verify/use TOCTOU window) and walks the advance-only
 * lifecycle:
 *
 *   pending ──► verifying ──► applying ──► committed
 *                    │             ├─────► rolled_back  (health gate failed,
 *                    │             │        previous digests restored)
 *                    │             └─────► failed       (rollback ALSO failed;
 *                    │                      failureReason degraded_health)
 *                    └───► rejected       (schema downgrade & friends,
 *                                          configs sha mismatch)
 *
 * The nine apply steps (design §WARP-539):
 *   1. snapshot previous digests + configs + DB schema into
 *      .data/updates/<id>/backup/;
 *   2. pull the release images BY DIGEST;
 *   3. stage the release configs (sha256-gated against the VERIFIED
 *      manifest before a byte is unpacked);
 *   4. `prisma migrate deploy` — gated on minOrchestratorSchema (the
 *      parse gate refuses `orchestrator_schema_unsupported` outright);
 *   5. recreate every manifest service EXCEPT the orchestrator via the
 *      scripts/lib/apply-update.sh helper over the host compose socket;
 *   6. health-gate them (the /health(z) probes from WARP-535, carried in
 *      each manifest service's `healthcheck` entry);
 *   7. swap the orchestrator itself LAST through a DETACHED helper
 *      container (it must survive this process's own recreation), then
 *      commit from the resumed orchestrator;
 *   8. on any health-gate failure: restore configs + recreate the
 *      previous digests → rolled_back;
 *   9. if the rollback's own health gate ALSO fails → failed +
 *      failureReason `degraded_health`.
 *
 * RESUMABILITY — every status transition is committed BEFORE the action
 * it guards, so the row is an exact restart cursor:
 *   - `verifying` at boot  → the process died before any swap; the whole
 *     apply is safe to re-run from the top (steps 1-4 are idempotent).
 *   - `applying` at boot   → the swap was in flight. Compare the RUNNING
 *     orchestrator image against the manifest target:
 *       · running == target → we are the NEW orchestrator: health-gate
 *         everything and commit (or start the detached full rollback);
 *       · running != target → the detached helper already rolled us back
 *         to the OLD image: health-gate the previous digests and write
 *         the rolled_back / failed verdict.
 *   `resumeInterruptedApply` is the onStart hook index.ts runs at boot.
 *
 * SETUP GATE — while the onboarding wizard is in progress
 * (ApplianceSetup.state !== "ready", the explicit lifecycle column — never
 * derived) the apply defers untouched: swapping containers mid-wizard
 * would yank the dashboard out from under the customer. NOTE this also
 * defers OTA on a never-claimed box — deliberate: an unclaimed box is
 * either mid-wizard or in a warehouse; neither should self-update.
 *
 * MIGRATIONS — step 4 runs `prisma migrate deploy` for THIS build's
 * migrations (idempotent; guarantees the swap never starts from a
 * half-migrated baseline). Migrations that SHIP WITH the new orchestrator
 * image are applied by the new image's own guarded boot entrypoint
 * (scripts/migrate-and-start.sh, WARP-573 — advisory-locked, pre-migrate
 * pg_dump snapshot, one-shot auto-recovery). The old orchestrator cannot
 * run migration files it does not have; the WARP-573 entrypoint is the
 * designed owner of that step. Rollback deliberately does NOT restore the
 * DB schema (migrations are additive by policy; the schema snapshot in
 * backup/ is forensic + manual-recovery material, same posture as the
 * WARP-573 snapshots).
 *
 * failureReason vocabulary added by this module (extends the WARP-537
 * `UpdateFailureReason` set, which stays canonical for verify/parse):
 *   - `configs_mismatch`    — configs.tar.gz sha256 != the verified
 *     manifest's configs.sha256 (rejected; wrong bytes, not transient —
 *     a truncated download throws and lands in retry instead);
 *   - `health_gate_failed`  — rides `rolled_back`: the post-swap gate
 *     failed and the rollback restored a healthy previous state;
 *   - `degraded_health`     — rides `failed`: the rollback ALSO failed
 *     its health gate (WARP-538 convention: NOT a new enum value).
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";
import { getSetupState } from "../setup.service.js";
import {
  parseReleaseManifest,
  type ReleaseManifest,
  type ReleaseService,
  type UpdateFailureReason,
} from "./manifest.js";
import { getUpdateAgentSettings } from "./settings.js";

const defaultLog = createLogger("update-agent");

/** The compose service name of the orchestrator itself (swapped LAST). */
export const SELF_SERVICE_NAME = "orchestrator";

/** Production health-gate posture: ~2 minutes of patience per gate. */
export const DEFAULT_HEALTH_GATE = { attempts: 24, intervalMs: 5_000 };

export type RecreateTarget = "release" | "previous";

export type ApplyFailureReason =
  | UpdateFailureReason
  | "configs_mismatch"
  | "health_gate_failed"
  | "degraded_health";

/**
 * Port to the compose-over-socket mechanics (production:
 * host-compose-runner.ts → detached helper containers running
 * scripts/lib/apply-update.sh; tests: an in-memory fake honoring the
 * same contract). apply.ts owns the state machine, the runner owns the
 * Docker surface — nothing in this module touches the socket directly.
 */
export interface ApplyRunner {
  /**
   * Image ref currently running for each compose service (repo digest
   * when the container came from a registry, image ID for locally-built
   * images — both are valid rollback pin targets). `null` = the service
   * has no running container (profile-gated / not deployed on this box);
   * such services are excluded from recreate + health gates.
   */
  currentImageRefs(services: string[]): Promise<Record<string, string | null>>;
  /**
   * Step 1 — write .data/updates/<id>/backup/: previous image refs
   * (rollback pins), the current host configs tree, and a
   * pg_dump --schema-only of the orchestrator DB.
   */
  snapshot(opts: {
    updateId: string;
    manifest: ReleaseManifest;
    previousRefs: Record<string, string | null>;
  }): Promise<void>;
  /** Step 2 — pull every manifest image BY DIGEST. */
  pullImages(services: ReleaseService[]): Promise<void>;
  /**
   * Step 3 — install the (already sha256-verified) release configs over
   * the host config tree; the pre-image lives in backup/ from step 1.
   */
  stageConfigs(opts: {
    updateId: string;
    configsTar: Buffer;
    manifest: ReleaseManifest;
  }): Promise<void>;
  /** Step 4 — `prisma migrate deploy` for this build's migrations. */
  migrateDeploy(): Promise<void>;
  /** Steps 5/8 — recreate the named services on release/previous refs. */
  recreateServices(opts: {
    updateId: string;
    services: string[];
    target: RecreateTarget;
  }): Promise<void>;
  /** Step 8 — restore the backed-up host configs. */
  restoreConfigs(opts: { updateId: string }): Promise<void>;
  /**
   * Step 7 — recreate the orchestrator itself via a DETACHED helper that
   * survives this process's death; the helper waits on the recreated
   * orchestrator's container healthcheck and on timeout rolls EVERY
   * manifest service back to the previous refs. Must return as soon as
   * the helper is launched.
   */
  recreateSelfDetached(opts: { updateId: string; target: RecreateTarget }): Promise<void>;
}

/** One health-probe attempt; true = healthy. */
export type HealthProbe = (service: ReleaseService) => Promise<boolean>;

/**
 * Production probe: GET the service's own auth-exempt liveness endpoint
 * over the compose network (http://<name>:<port><path> — the WARP-535
 * /health(z) surface, snapshotted per-service in the verified manifest).
 * `baseUrlFor` is injectable so tests can point the SAME probe code at a
 * local fixture server.
 */
export function httpHealthProbe(opts?: {
  baseUrlFor?: (service: ReleaseService) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): HealthProbe {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  return async (service) => {
    if (service.healthcheck.type !== "http") return true;
    const base =
      opts?.baseUrlFor?.(service) ?? `http://${service.name}:${service.healthcheck.port}`;
    try {
      const res = await fetchImpl(`${base}${service.healthcheck.path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/**
 * Does a running image ref satisfy a manifest digest? Accepts the bare
 * digest, a repo-digest ref (`…@sha256:<hex>`), or the pinned image
 * string itself. A locally-built image ID never matches a release digest
 * — which is exactly the signal the resume path keys on.
 */
export function imageRefMatchesDigest(ref: string | null, digest: string): boolean {
  if (!ref) return false;
  return ref === digest || ref.endsWith(`@${digest}`);
}

export interface ApplyUpdateOptions {
  prisma: PrismaClient;
  runner: ApplyRunner;
  /** GitHub Releases `latest` endpoint (config.DROPLET_OTA_RELEASES_URL). */
  releasesLatestUrl: string;
  githubToken?: string;
  fetchImpl?: typeof fetch;
  logger?: pino.Logger;
  probe?: HealthProbe;
  healthGate?: { attempts: number; intervalMs: number };
}

export type ApplyUpdateResult =
  | { outcome: "nothing_pending" }
  | { outcome: "deferred_setup_in_progress"; deviceUpdateId: string }
  | {
      outcome: "rejected";
      deviceUpdateId: string;
      failureReason: ApplyFailureReason;
      detail: string;
    }
  | { outcome: "retry_later"; deviceUpdateId: string; detail: string }
  | { outcome: "rolled_back"; deviceUpdateId: string }
  | { outcome: "failed"; deviceUpdateId: string }
  | { outcome: "self_swap_started"; deviceUpdateId: string };

export type ResumeResult =
  | { outcome: "nothing_to_resume" }
  | { outcome: "committed"; deviceUpdateId: string }
  | { outcome: "rolled_back"; deviceUpdateId: string }
  | { outcome: "failed"; deviceUpdateId: string }
  | { outcome: "self_rollback_started"; deviceUpdateId: string }
  | { outcome: "resumed_apply"; deviceUpdateId: string; result: ApplyUpdateResult };

export type ApplyWindowResult =
  | ApplyUpdateResult
  | { outcome: "deferred_auto_apply_off"; deviceUpdateId: string };

interface DeviceUpdateRowSlice {
  id: string;
  status: string;
  releaseTag: string | null;
  gitSha: string;
  manifestJson: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setStatus(
  prisma: PrismaClient,
  id: string,
  status: "verifying" | "applying" | "committed" | "rolled_back" | "failed" | "rejected",
  failureReason: string | null = null,
): Promise<void> {
  // Committed BEFORE the action the new status guards — this write IS the
  // resumability contract.
  await prisma.deviceUpdate.update({ where: { id }, data: { status, failureReason } });
}

/**
 * Run the gate for every probeable (http-type, currently-running) service
 * in the list. Returns the first service name that never went healthy, or
 * null when all gates pass.
 */
async function healthGate(
  services: ReleaseService[],
  probe: HealthProbe,
  gate: { attempts: number; intervalMs: number },
): Promise<string | null> {
  for (const service of services) {
    if (service.healthcheck.type !== "http") continue;
    let ok = false;
    for (let attempt = 0; attempt < gate.attempts; attempt += 1) {
      if (await probe(service)) {
        ok = true;
        break;
      }
      await sleep(gate.intervalMs);
    }
    if (!ok) return service.name;
  }
  return null;
}

/**
 * Download the release's configs asset and verify it against the VERIFIED
 * manifest's sha256 — the signed manifest is the trust anchor, the asset
 * download only has to match it.
 */
async function fetchConfigsAsset(
  opts: ApplyUpdateOptions,
  row: DeviceUpdateRowSlice,
  manifest: ReleaseManifest,
): Promise<
  | { ok: true; configsTar: Buffer }
  | { ok: false; kind: "transient"; detail: string }
  | { ok: false; kind: "mismatch"; detail: string }
> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const authHeaders: Record<string, string> = opts.githubToken
    ? { authorization: `Bearer ${opts.githubToken}` }
    : {};
  let assetUrl: string | undefined;
  try {
    const res = await fetchImpl(opts.releasesLatestUrl, {
      headers: { accept: "application/vnd.github+json", ...authHeaders },
    });
    if (!res.ok) {
      return { ok: false, kind: "transient", detail: `releases endpoint HTTP ${res.status}` };
    }
    const release = (await res.json()) as {
      tag_name?: string;
      assets?: Array<{ name: string; url: string }>;
    };
    if (row.releaseTag && release.tag_name && release.tag_name !== row.releaseTag) {
      // The latest release moved on mid-apply; the poller will supersede
      // this row on its next tick. Retry semantics keep us honest.
      return {
        ok: false,
        kind: "transient",
        detail: `latest release is ${release.tag_name}, row tracks ${row.releaseTag}`,
      };
    }
    assetUrl = release.assets?.find((a) => a.name === manifest.configs.file)?.url;
  } catch (err) {
    return {
      ok: false,
      kind: "transient",
      detail: `releases endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!assetUrl) {
    return {
      ok: false,
      kind: "transient",
      detail: `release has no ${manifest.configs.file} asset`,
    };
  }

  let configsTar: Buffer;
  try {
    const res = await fetchImpl(assetUrl, {
      headers: { accept: "application/octet-stream", ...authHeaders },
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, kind: "transient", detail: `configs download HTTP ${res.status}` };
    }
    configsTar = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return {
      ok: false,
      kind: "transient",
      detail: `configs download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sha = createHash("sha256").update(configsTar).digest("hex");
  if (sha !== manifest.configs.sha256) {
    // A COMPLETE download with the wrong bytes — tampering or a corrupt
    // release, never transient (a truncated body throws above).
    return {
      ok: false,
      kind: "mismatch",
      detail: `configs sha256 ${sha} != manifest ${manifest.configs.sha256}`,
    };
  }
  return { ok: true, configsTar };
}

/**
 * Apply the newest pending (or resumable `verifying`) DeviceUpdate row —
 * steps 1-9. Never throws for expected failure shapes: every exit is a
 * typed outcome + a structured `update.*` log event (poller posture).
 */
export async function applyPendingUpdate(
  opts: ApplyUpdateOptions,
): Promise<ApplyUpdateResult> {
  const log = opts.logger ?? defaultLog;
  const gate = opts.healthGate ?? DEFAULT_HEALTH_GATE;
  const probe = opts.probe ?? httpHealthProbe();
  const { prisma, runner } = opts;

  // `verifying` rows are restart cursors (a prior attempt died pre-swap
  // or hit a transient fetch failure) — same pipeline, same top.
  const row = (await prisma.deviceUpdate.findFirst({
    where: { status: { in: ["pending", "verifying"] } },
    orderBy: { createdAt: "desc" },
  })) as DeviceUpdateRowSlice | null;
  if (!row) return { outcome: "nothing_pending" };

  // ── setup gate: never swap containers under a mid-wizard customer ──
  const setup = await getSetupState(prisma);
  if (setup.appliance !== "ready") {
    log.info(
      {
        event: "update.apply_deferred",
        deviceUpdateId: row.id,
        applianceState: setup.appliance,
      },
      "OTA apply deferred — appliance setup is in progress",
    );
    return { outcome: "deferred_setup_in_progress", deviceUpdateId: row.id };
  }

  // ── pending → verifying (committed BEFORE any validation/side effect) ──
  if (row.status !== "verifying") {
    await setStatus(prisma, row.id, "verifying");
  }

  // ── re-validate the snapshotted manifest (schema gates incl.
  //    minOrchestratorSchema — a schema-downgrade manifest dies here) ──
  const parsed = parseReleaseManifest(JSON.stringify(row.manifestJson));
  if (!parsed.ok) {
    await setStatus(prisma, row.id, "rejected", parsed.failureReason);
    log.warn(
      {
        event: "update.rejected",
        deviceUpdateId: row.id,
        failureReason: parsed.failureReason,
        detail: parsed.detail,
      },
      "OTA apply rejected — manifest failed re-validation",
    );
    return {
      outcome: "rejected",
      deviceUpdateId: row.id,
      failureReason: parsed.failureReason,
      detail: parsed.detail,
    };
  }
  const manifest = parsed.manifest;

  // ── fetch + sha256-gate the configs asset against the verified manifest ──
  const configs = await fetchConfigsAsset(opts, row, manifest);
  if (!configs.ok) {
    if (configs.kind === "mismatch") {
      await setStatus(prisma, row.id, "rejected", "configs_mismatch");
      log.warn(
        {
          event: "update.rejected",
          deviceUpdateId: row.id,
          failureReason: "configs_mismatch",
          detail: configs.detail,
        },
        "OTA apply rejected — configs asset does not match the verified manifest",
      );
      return {
        outcome: "rejected",
        deviceUpdateId: row.id,
        failureReason: "configs_mismatch",
        detail: configs.detail,
      };
    }
    log.warn(
      { event: "update.apply_retry", deviceUpdateId: row.id, detail: configs.detail },
      "OTA apply hit a transient failure — row stays verifying for the next window",
    );
    return { outcome: "retry_later", deviceUpdateId: row.id, detail: configs.detail };
  }

  const serviceNames = manifest.services.map((s) => s.name);

  // ── step 1: snapshot previous digests + configs + schema ──
  const previousRefs = await runner.currentImageRefs(serviceNames);
  await runner.snapshot({ updateId: row.id, manifest, previousRefs });

  // Only services actually deployed on this box are swapped/gated —
  // `up`-ing a profile-gated service that has never run here would GROW
  // the deployment, not update it.
  const deployed = manifest.services.filter((s) => previousRefs[s.name] !== null);
  const sidecars = deployed.filter((s) => s.name !== SELF_SERVICE_NAME);
  const sidecarNames = sidecars.map((s) => s.name);

  // ── step 2: pull by digest ── step 3: stage configs ── step 4: migrate ──
  await runner.pullImages(manifest.services);
  await runner.stageConfigs({ updateId: row.id, configsTar: configs.configsTar, manifest });
  // minOrchestratorSchema gate: enforced by parseReleaseManifest above
  // (orchestrator_schema_unsupported → rejected before any side effect).
  await runner.migrateDeploy();

  // ── verifying → applying (committed BEFORE the first recreate) ──
  await setStatus(prisma, row.id, "applying");
  log.info(
    {
      event: "update.apply_started",
      deviceUpdateId: row.id,
      gitSha: row.gitSha,
      services: sidecarNames,
    },
    "OTA apply started — recreating services on the release digests",
  );

  // ── step 5: recreate sidecars ── step 6: health-gate them ──
  await runner.recreateServices({ updateId: row.id, services: sidecarNames, target: "release" });
  const unhealthy = await healthGate(sidecars, probe, gate);
  if (unhealthy !== null) {
    log.warn(
      { event: "update.rollback", deviceUpdateId: row.id, unhealthyService: unhealthy },
      "OTA health gate failed — rolling back to the previous digests",
    );
    // ── step 8: inline rollback (this orchestrator was never swapped) ──
    await runner.restoreConfigs({ updateId: row.id });
    await runner.recreateServices({
      updateId: row.id,
      services: sidecarNames,
      target: "previous",
    });
    const stillUnhealthy = await healthGate(sidecars, probe, gate);
    if (stillUnhealthy !== null) {
      // ── step 9: rollback also failed ──
      await setStatus(prisma, row.id, "failed", "degraded_health");
      log.error(
        {
          event: "update.failed",
          deviceUpdateId: row.id,
          failureReason: "degraded_health",
          unhealthyService: stillUnhealthy,
        },
        "OTA rollback ALSO failed its health gate — appliance is degraded",
      );
      return { outcome: "failed", deviceUpdateId: row.id };
    }
    await setStatus(prisma, row.id, "rolled_back", "health_gate_failed");
    log.warn(
      { event: "update.rolled_back", deviceUpdateId: row.id, unhealthyService: unhealthy },
      "OTA update rolled back — previous digests restored and healthy",
    );
    return { outcome: "rolled_back", deviceUpdateId: row.id };
  }

  // ── step 7: swap the orchestrator itself, LAST, detached ──
  // The row stays `applying`; the verdict is written by whichever
  // orchestrator boots next (resumeInterruptedApply).
  await runner.recreateSelfDetached({ updateId: row.id, target: "release" });
  log.info(
    { event: "update.self_swap_started", deviceUpdateId: row.id, gitSha: row.gitSha },
    "OTA sidecars healthy — detached helper is recreating the orchestrator",
  );
  return { outcome: "self_swap_started", deviceUpdateId: row.id };
}

/**
 * onStart hook (index.ts, right after the update-agent settings load):
 * resume whatever the previous orchestrator process left in flight.
 */
export async function resumeInterruptedApply(
  opts: ApplyUpdateOptions,
): Promise<ResumeResult> {
  const log = opts.logger ?? defaultLog;
  const gate = opts.healthGate ?? DEFAULT_HEALTH_GATE;
  const probe = opts.probe ?? httpHealthProbe();
  const { prisma, runner } = opts;

  const applying = (await prisma.deviceUpdate.findFirst({
    where: { status: "applying" },
    orderBy: { createdAt: "desc" },
  })) as DeviceUpdateRowSlice | null;

  if (applying) {
    const parsed = parseReleaseManifest(JSON.stringify(applying.manifestJson));
    if (!parsed.ok) {
      // Can't happen for a row that reached `applying` unless the DB was
      // hand-edited; fail the row loudly rather than guessing.
      await setStatus(prisma, applying.id, "failed", parsed.failureReason);
      log.error(
        { event: "update.failed", deviceUpdateId: applying.id, failureReason: parsed.failureReason },
        "OTA resume found an applying row with an unparseable manifest snapshot",
      );
      return { outcome: "failed", deviceUpdateId: applying.id };
    }
    const manifest = parsed.manifest;
    const self = manifest.services.find((s) => s.name === SELF_SERVICE_NAME);
    const refs = await runner.currentImageRefs(manifest.services.map((s) => s.name));
    const deployed = manifest.services.filter((s) => refs[s.name] !== null);
    const runningTarget =
      self !== undefined && imageRefMatchesDigest(refs[SELF_SERVICE_NAME] ?? null, self.digest);

    if (runningTarget) {
      // We ARE the new orchestrator — final gate over ALL services
      // (sidecars were gated pre-swap; this re-checks them plus self).
      const unhealthy = await healthGate(deployed, probe, gate);
      if (unhealthy === null) {
        await setStatus(prisma, applying.id, "committed", null);
        log.info(
          { event: "update.committed", deviceUpdateId: applying.id, gitSha: applying.gitSha },
          "OTA update committed — all services healthy on the release digests",
        );
        return { outcome: "committed", deviceUpdateId: applying.id };
      }
      // Full detached rollback — the OLD orchestrator's resume writes the
      // rolled_back / failed verdict once it is back.
      log.warn(
        {
          event: "update.rollback",
          deviceUpdateId: applying.id,
          unhealthyService: unhealthy,
        },
        "OTA post-swap health gate failed — starting the detached full rollback",
      );
      await runner.restoreConfigs({ updateId: applying.id });
      await runner.recreateServices({
        updateId: applying.id,
        services: deployed.filter((s) => s.name !== SELF_SERVICE_NAME).map((s) => s.name),
        target: "previous",
      });
      await runner.recreateSelfDetached({ updateId: applying.id, target: "previous" });
      return { outcome: "self_rollback_started", deviceUpdateId: applying.id };
    }

    // Running the OLD image with an `applying` row → the detached helper
    // rolled the swap back (or it never landed). Gate the previous state
    // and write the verdict.
    const unhealthy = await healthGate(deployed, probe, gate);
    if (unhealthy !== null) {
      await setStatus(prisma, applying.id, "failed", "degraded_health");
      log.error(
        {
          event: "update.failed",
          deviceUpdateId: applying.id,
          failureReason: "degraded_health",
          unhealthyService: unhealthy,
        },
        "OTA rollback state failed its health gate — appliance is degraded",
      );
      return { outcome: "failed", deviceUpdateId: applying.id };
    }
    await setStatus(prisma, applying.id, "rolled_back", "health_gate_failed");
    log.warn(
      { event: "update.rolled_back", deviceUpdateId: applying.id, gitSha: applying.gitSha },
      "OTA update rolled back — previous digests restored and healthy",
    );
    return { outcome: "rolled_back", deviceUpdateId: applying.id };
  }

  const verifying = (await prisma.deviceUpdate.findFirst({
    where: { status: "verifying" },
    orderBy: { createdAt: "desc" },
  })) as DeviceUpdateRowSlice | null;
  if (verifying) {
    log.info(
      { event: "update.apply_resumed", deviceUpdateId: verifying.id },
      "OTA apply interrupted pre-swap — re-running from the top",
    );
    const result = await applyPendingUpdate(opts);
    return { outcome: "resumed_apply", deviceUpdateId: verifying.id, result };
  }

  return { outcome: "nothing_to_resume" };
}

/**
 * Maintenance-window tick (replaces the WARP-538 stub at the index.ts
 * call site — the stub itself is carried byte-identical in poller.ts and
 * stays unwired). Honors the persisted autoApply switch; the setup gate
 * lives inside applyPendingUpdate so EVERY apply path defers mid-wizard.
 */
export async function applyWindowTick(opts: ApplyUpdateOptions): Promise<ApplyWindowResult> {
  const log = opts.logger ?? defaultLog;
  const pending = (await opts.prisma.deviceUpdate.findFirst({
    where: { status: { in: ["pending", "verifying"] } },
    orderBy: { createdAt: "desc" },
  })) as DeviceUpdateRowSlice | null;
  if (!pending) return { outcome: "nothing_pending" };

  const settings = await getUpdateAgentSettings(opts.prisma);
  if (!settings.autoApply) {
    log.info(
      {
        event: "update.apply_window_waiting",
        deviceUpdateId: pending.id,
        gitSha: pending.gitSha,
        autoApply: false,
      },
      "apply window reached with autoApply off — waiting for an explicit apply (WARP-540)",
    );
    return { outcome: "deferred_auto_apply_off", deviceUpdateId: pending.id };
  }
  return applyPendingUpdate(opts);
}
