/**
 * WARP-539 — production ApplyRunner: the compose-over-socket implementation
 * of the port apply.ts owns. This is the ONLY module in the orchestrator
 * that drives the host Docker daemon, and it does so through exactly one
 * host helper — scripts/lib/apply-update.sh — invoked with an ARGV ARRAY
 * (never a shell string). A manifest field (service name, image ref) can
 * therefore never be reinterpreted as a shell command: `execFile` hands the
 * tokens straight to the script with no `/bin/sh -c` in between.
 *
 * ── SECURITY POSTURE (why this exists + how it's fenced) ──
 * The apply step recreates every appliance container — INCLUDING the
 * orchestrator itself — which requires talking to the host Docker daemon.
 * The orchestrator container mounts /var/run/docker.sock (see
 * docker/docker-compose.yml, orchestrator service, the WARP-539 volume +
 * its comment). A Docker socket is root-equivalent on the host, so:
 *   - the mount is on the orchestrator service ONLY (no sidecar gets it);
 *   - nothing in the codebase talks to the socket directly — every daemon
 *     op funnels through this runner → the one audited host script, whose
 *     surface is a fixed set of subcommands, not an arbitrary `docker` shim;
 *   - the script itself validates its inputs against the tracked compose
 *     file and refuses anything outside the manifest's service set.
 * The trust chain that got us here is already cryptographic: only a
 * cosign-verified (WARP-537) manifest whose configs.tar.gz sha256 matches
 * (apply.ts) ever reaches this runner. The socket is the blast radius; the
 * verify chain is the gate in front of it.
 *
 * The payloads that don't fit cleanly in argv (the manifest, the previous
 * image refs, the configs tarball) are staged as FILES under
 * <updatesDir>/<updateId>/ and the script is handed their paths — this
 * dodges both argv length limits and any quoting ambiguity, and it doubles
 * as the rollback backup step 1 writes.
 *
 * ── PER-TARGET DIGEST PINNING (the compose-override contract) ──
 * The appliance compose file defines the first-party services (orchestrator,
 * web-dashboard, …) as `build:`-only — no `image:` key — so a bare
 * `docker compose up --force-recreate` would reuse the LOCAL build and
 * silently ignore any digest `pull-images` fetched: release-vs-previous
 * would be a no-op. The snapshot step therefore generates, per update:
 *
 *   <updatesDir>/<id>/override-release.yml   — every DEPLOYED service pinned
 *                                              to its manifest digest ref;
 *   <updatesDir>/<id>/override-previous.yml  — the same services pinned to
 *                                              the refs that were running
 *                                              (repo digest or image ID);
 *   <updatesDir>/<id>/services.txt           — the rollback walk order (one
 *                                              name per line, orchestrator
 *                                              LAST — swap-last both ways).
 *
 * apply-update.sh consumes them as `-f <compose> -f <override>` — the merge
 * ADDS an `image:` key to each build:-only service, and together with
 * `--no-build --pull never` compose recreates the container FROM the pinned
 * ref that was already pulled (release) or is already present (previous).
 * Services not running on this box (null previous ref) are pinned NOWHERE:
 * recreating them would grow the deployment, not update it (apply.ts).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";
import {
  SELF_SERVICE_NAME,
  type ApplyRunner,
  type RecreateTarget,
} from "./apply.js";
import type { ReleaseManifest, ReleaseService } from "./manifest.js";

const defaultLog = createLogger("update-agent");

/**
 * Injectable exec boundary. Production wires the real `execFile`; tests
 * assert the argv the runner builds without spawning anything.
 */
export type ExecFn = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface HostComposeRunnerOptions {
  /** Absolute path to the host helper (scripts/lib/apply-update.sh). */
  scriptPath: string;
  /** Absolute path to the on-host compose file the script drives. */
  composeFile: string;
  /** Root under which <updateId>/{backup,configs.tar.gz} are staged. */
  updatesDir: string;
  exec?: ExecFn;
  logger?: pino.Logger;
  /**
   * Per-step timeouts. Image pulls + recreates are the long ones; the
   * detached self-swap returns as soon as the helper is launched.
   */
  timeouts?: {
    quickMs?: number;
    pullMs?: number;
    recreateMs?: number;
  };
}

/** Real exec boundary — `execFile`, promisified, with a byte cap. */
export function defaultExec(): ExecFn {
  return (file, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: opts?.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            // Carry BOTH streams onto the error: a non-zero exit can still
            // print a structured payload on stdout (recreate-services'
            // {"failed":[…]} list) that the caller needs to surface.
            (err as Error & { stdout?: string; stderr?: string }).stdout = stdout;
            (err as Error & { stdout?: string; stderr?: string }).stderr = stderr;
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}

const DEFAULT_TIMEOUTS = { quickMs: 60_000, pullMs: 600_000, recreateMs: 300_000 };

/**
 * Compose service name shape — mirrors apply-update.sh's `validate_services`
 * (`[a-z0-9-]`, comma-separated there). Anything else never came from a
 * parsed manifest and must not reach the generated YAML.
 */
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Image ref / image ID shape safe to embed UNQUOTED in the generated
 * override YAML: one registry/digest token — no whitespace, quotes, or YAML
 * structure characters. Covers `ghcr.io/x/y:tag`, `…@sha256:<hex>`, and the
 * bare `sha256:<hex>` image IDs `docker inspect` reports for local builds.
 */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/**
 * Render one per-target compose override. Refs come from a cosign-verified
 * manifest (release) or from `docker inspect` (previous) — a shape violation
 * here means something upstream is corrupted, so we REFUSE rather than try
 * to quote around it: a hostile ref must never rewrite the YAML structure
 * that pins what runs on the box.
 */
function composeOverrideYaml(
  target: RecreateTarget,
  updateId: string,
  pins: Array<{ name: string; image: string }>,
): string {
  const lines = [
    `# WARP-539 — GENERATED compose override for update ${updateId}: pins every`,
    `# service deployed on this box to its ${target} image ref. Consumed by`,
    `# scripts/lib/apply-update.sh as the second -f (base + override) so`,
    `# build:-only services are recreated FROM the pinned ref, never from the`,
    `# local build. DO NOT EDIT — rewritten by the orchestrator's snapshot step.`,
    "services:",
  ];
  for (const pin of pins) {
    if (!SERVICE_NAME_RE.test(pin.name)) {
      throw new Error(
        `OTA override (${target}): unsafe compose service name ${JSON.stringify(pin.name)}`,
      );
    }
    if (!IMAGE_REF_RE.test(pin.image)) {
      throw new Error(
        `OTA override (${target}): unsafe image ref ${JSON.stringify(pin.image)} for service "${pin.name}"`,
      );
    }
    lines.push(`  ${pin.name}:`, `    image: ${pin.image}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Raised when `recreate-services` reports that one or more services failed to
 * recreate. The script attempts EVERY service (no mid-loop abort) and returns
 * the failed names as {"failed":[…]}; this error names them so the caller
 * (and its logs) can see exactly which services did NOT swap, instead of a
 * bare "command failed" that hides the mixed-version state.
 */
export class RecreateServicesError extends Error {
  readonly failedServices: string[];
  readonly target: RecreateTarget;
  constructor(target: RecreateTarget, failedServices: string[], cause?: unknown) {
    super(
      `OTA recreate-services (${target}) failed for: ${failedServices.join(", ")}`,
    );
    this.name = "RecreateServicesError";
    this.failedServices = failedServices;
    this.target = target;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Pull the structured {"failed":[…]} list off a recreate-services result —
 * from the stdout of a clean run, or from the stdout the script printed
 * alongside its non-zero exit (attached to the thrown error by defaultExec).
 * Returns null when there is no parseable payload.
 */
function parseFailedServices(text: string | undefined): string[] | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { failed?: unknown };
    if (Array.isArray(parsed.failed)) {
      return parsed.failed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // Not JSON — fall through to null (an unexpected failure shape).
  }
  return null;
}

export function createHostComposeRunner(opts: HostComposeRunnerOptions): ApplyRunner {
  const log = opts.logger ?? defaultLog;
  const exec = opts.exec ?? defaultExec();
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };

  /** Every invocation carries the compose file the script must drive. */
  const composeArgs = ["--compose-file", opts.composeFile];

  async function run(
    subcommand: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    const argv = [subcommand, ...composeArgs, ...args];
    try {
      const { stdout } = await exec(opts.scriptPath, argv, { timeoutMs });
      return stdout;
    } catch (err) {
      log.error(
        {
          event: "update.host_script_failed",
          subcommand,
          err: err instanceof Error ? err.message : String(err),
          stderr: (err as { stderr?: string }).stderr,
        },
        "OTA host helper (apply-update.sh) failed",
      );
      throw err;
    }
  }

  function updateDir(updateId: string): string {
    return path.join(opts.updatesDir, updateId);
  }

  return {
    async currentImageRefs(services: string[]): Promise<Record<string, string | null>> {
      const stdout = await run(
        "current-image-refs",
        ["--services", services.join(",")],
        timeouts.quickMs,
      );
      const parsed = stdout.trim() ? (JSON.parse(stdout) as Record<string, string | null>) : {};
      // Null-fill any service the script didn't report so callers get a
      // total map keyed by exactly what they asked for.
      return Object.fromEntries(
        services.map((s) => [s, s in parsed ? parsed[s] ?? null : null]),
      );
    },

    async snapshot(args: {
      updateId: string;
      manifest: ReleaseManifest;
      previousRefs: Record<string, string | null>;
    }): Promise<void> {
      const dir = updateDir(args.updateId);
      const backupDir = path.join(dir, "backup");
      await mkdir(backupDir, { recursive: true });
      // Rollback pins + the verified manifest ride files, not argv.
      await writeFile(
        path.join(backupDir, "previous-refs.json"),
        JSON.stringify(args.previousRefs, null, 2),
      );
      await writeFile(
        path.join(backupDir, "manifest.json"),
        JSON.stringify(args.manifest, null, 2),
      );
      // Per-target compose overrides + the rollback services list (see the
      // PER-TARGET DIGEST PINNING header note). Only services DEPLOYED on
      // this box (non-null previous ref) are pinned; the orchestrator is
      // ordered LAST so the detached helper's rollback walk swaps it last,
      // mirroring the forward apply order.
      const deployed = args.manifest.services.filter(
        (s) => args.previousRefs[s.name] != null,
      );
      const ordered = [
        ...deployed.filter((s) => s.name !== SELF_SERVICE_NAME),
        ...deployed.filter((s) => s.name === SELF_SERVICE_NAME),
      ];
      await writeFile(
        path.join(dir, "override-release.yml"),
        composeOverrideYaml(
          "release",
          args.updateId,
          ordered.map((s) => ({ name: s.name, image: s.image })),
        ),
      );
      await writeFile(
        path.join(dir, "override-previous.yml"),
        composeOverrideYaml(
          "previous",
          args.updateId,
          // Non-null by the `deployed` filter above.
          ordered.map((s) => ({ name: s.name, image: args.previousRefs[s.name] as string })),
        ),
      );
      await writeFile(
        path.join(dir, "services.txt"),
        `${ordered.map((s) => s.name).join("\n")}\n`,
      );
      // The script captures the host config tree pre-image + a schema-only
      // pg_dump into the same backup dir.
      await run(
        "snapshot",
        ["--update-id", args.updateId, "--backup-dir", backupDir],
        timeouts.quickMs,
      );
    },

    async pullImages(services: ReleaseService[]): Promise<void> {
      await run(
        "pull-images",
        ["--images", ...services.map((s) => s.image)],
        timeouts.pullMs,
      );
    },

    async stageConfigs(args: {
      updateId: string;
      configsTar: Buffer;
      manifest: ReleaseManifest;
    }): Promise<void> {
      const dir = updateDir(args.updateId);
      await mkdir(dir, { recursive: true });
      const tarPath = path.join(dir, "configs.tar.gz");
      await writeFile(tarPath, args.configsTar);
      await run(
        "stage-configs",
        ["--update-id", args.updateId, "--configs-tar", tarPath],
        timeouts.quickMs,
      );
    },

    async migrateDeploy(): Promise<void> {
      await run("migrate-deploy", [], timeouts.recreateMs);
    },

    async recreateServices(args: {
      updateId: string;
      services: string[];
      target: RecreateTarget;
    }): Promise<void> {
      const argv = [
        "--update-id",
        args.updateId,
        "--services",
        args.services.join(","),
        "--target",
        args.target,
      ];
      let stdout: string;
      try {
        stdout = await run("recreate-services", argv, timeouts.recreateMs);
      } catch (err) {
        // The script attempts every service and reports the failures as
        // {"failed":[…]} on stdout even when it exits non-zero. Surface that
        // list as a typed error naming the services that did not swap; if
        // there's no parseable list, re-throw the original (some other fault).
        const failed = parseFailedServices((err as { stdout?: string }).stdout);
        if (failed && failed.length > 0) {
          throw new RecreateServicesError(args.target, failed, err);
        }
        throw err;
      }
      // A clean (exit-0) run still reports {"failed":[]}; a non-empty list on
      // a zero exit would be a script contract violation — surface it too.
      const failed = parseFailedServices(stdout);
      if (failed && failed.length > 0) {
        throw new RecreateServicesError(args.target, failed);
      }
    },

    async restoreConfigs(args: { updateId: string }): Promise<void> {
      await run("restore-configs", [args.updateId], timeouts.quickMs);
    },

    async recreateSelfDetached(args: {
      updateId: string;
      target: RecreateTarget;
    }): Promise<void> {
      // Fire-and-forget from the orchestrator's POV: the script launches a
      // DETACHED helper container that outlives this process's own
      // recreation and returns as soon as the helper is up.
      await run(
        "recreate-self-detached",
        ["--update-id", args.updateId, "--target", args.target],
        timeouts.quickMs,
      );
    },
  };
}
