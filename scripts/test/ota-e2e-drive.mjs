#!/usr/bin/env node
/**
 * WARP-541 — OTA hardware-E2E driver. Runs INSIDE the orchestrator
 * container (the ota-e2e.yml workflow `docker cp`s it to
 * /app/apps/orchestrator/ and `docker exec`s it there), where it invokes
 * the SAME production entrypoints the orchestrator's crons call
 * (index.ts wiring): checkForUpdate, applyWindowTick over the real
 * host-compose runner, and the settings writer. It is a TRIGGER for the
 * real code paths — not a reimplementation, not a mock. There is no
 * operator CLI for the update agent (droplet-admin has no OTA
 * subcommand), so this file is the on-demand stand-in for the 15-minute
 * poll tick and the 03:00 apply window that a hardware E2E cannot wait
 * for.
 *
 * Subcommands (all print shell-greppable `OUTCOME <x>` / `GITSHA <y>`
 * lines plus one `RESULT <json>` line):
 *   settings --channel <name> [--auto-apply true|false]
 *       saveUpdateAgentSettings — the strict-validated production writer.
 *   check [--releases-url URL] [--expect a,b]
 *       One poll tick (checkForUpdate). URL defaults to the container's
 *       DROPLET_OTA_RELEASES_URL.
 *   apply-window [--releases-url URL] [--expect a,b]
 *       One maintenance-window tick (applyWindowTick) over the REAL
 *       compose-over-socket runner. Requires DROPLET_OTA_APPLY_SCRIPT to
 *       be provisioned on the box; refuses loudly otherwise. NOTE: when
 *       the apply reaches the self-swap, THIS process's container is
 *       recreated out from under the exec session — the caller must
 *       treat the exec exit code as informational and read the verdict
 *       from the DeviceUpdate table.
 *   status [--git-sha SHA]
 *       Print DeviceUpdate rows (newest first) as JSON lines.
 *   verify-running --git-sha SHA
 *       Assert every service deployed on this box runs the digest pinned
 *       in that row's verified manifest snapshot (imageRefMatchesDigest —
 *       the same predicate the resume path trusts). Exit 1 on mismatch.
 *
 * `--expect a,b` exits 1 unless the tick's typed outcome is listed —
 * the workflow's per-step assertions ride this.
 */
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { checkForUpdate } from "./dist/services/update-agent/poller.js";
import {
  applyWindowTick,
  imageRefMatchesDigest,
  SELF_SERVICE_NAME,
} from "./dist/services/update-agent/apply.js";
import { createHostComposeRunner } from "./dist/services/update-agent/host-compose-runner.js";
import { parseReleaseManifest } from "./dist/services/update-agent/manifest.js";
import {
  getUpdateAgentSettings,
  saveUpdateAgentSettings,
} from "./dist/services/update-agent/settings.js";

const prisma = new PrismaClient();

const env = {
  releasesUrl: process.env.DROPLET_OTA_RELEASES_URL ?? "",
  githubToken: process.env.DROPLET_OTA_GITHUB_TOKEN || undefined,
  applyScript: process.env.DROPLET_OTA_APPLY_SCRIPT ?? "",
  composeFile:
    process.env.DROPLET_OTA_COMPOSE_FILE ?? "/opt/droplet/docker/docker-compose.yml",
  updatesDir: process.env.DROPLET_OTA_UPDATES_DIR ?? "/data/updates",
};

function emit(result) {
  if (result && typeof result.outcome === "string") {
    console.log(`OUTCOME ${result.outcome}`);
  }
  if (result && typeof result.gitSha === "string") {
    console.log(`GITSHA ${result.gitSha}`);
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
}

function assertExpected(result, expect) {
  if (!expect) return;
  const allowed = expect.split(",").map((s) => s.trim());
  if (!allowed.includes(result.outcome)) {
    console.error(
      `EXPECT-FAILED: outcome "${result.outcome}" not in [${allowed.join(", ")}]`,
    );
    process.exitCode = 1;
  }
}

function buildRunner() {
  if (!env.applyScript) {
    console.error(
      "EXPECT-FAILED: DROPLET_OTA_APPLY_SCRIPT is empty — OTA apply is not " +
        "provisioned on this box (compose socket + apply-update.sh mount " +
        "required; see docker/docker-compose.yml, orchestrator service).",
    );
    process.exit(1);
  }
  return createHostComposeRunner({
    scriptPath: env.applyScript,
    composeFile: env.composeFile,
    updatesDir: env.updatesDir,
  });
}

const [subcommand, ...rest] = process.argv.slice(2);
const { values: flags } = parseArgs({
  args: rest,
  options: {
    channel: { type: "string" },
    "auto-apply": { type: "string" },
    "releases-url": { type: "string" },
    "git-sha": { type: "string" },
    expect: { type: "string" },
  },
});

try {
  switch (subcommand) {
    case "settings": {
      if (!flags.channel && flags["auto-apply"] === undefined) {
        throw new Error("settings: pass --channel and/or --auto-apply");
      }
      const patch = {};
      if (flags.channel) patch.channel = flags.channel;
      if (flags["auto-apply"] !== undefined) {
        patch.autoApply = flags["auto-apply"] === "true";
      }
      const next = await saveUpdateAgentSettings(prisma, patch);
      emit({ outcome: "settings_saved", settings: next });
      break;
    }

    case "check": {
      const settings = await getUpdateAgentSettings(prisma);
      console.log(`CHANNEL ${settings.channel}`);
      const result = await checkForUpdate({
        prisma,
        releasesLatestUrl: flags["releases-url"] ?? env.releasesUrl,
        githubToken: env.githubToken,
      });
      emit(result);
      assertExpected(result, flags.expect);
      break;
    }

    case "apply-window": {
      const result = await applyWindowTick({
        prisma,
        runner: buildRunner(),
        releasesLatestUrl: flags["releases-url"] ?? env.releasesUrl,
        githubToken: env.githubToken,
      });
      emit(result);
      assertExpected(result, flags.expect);
      break;
    }

    case "status": {
      const rows = await prisma.deviceUpdate.findMany({
        where: flags["git-sha"] ? { gitSha: flags["git-sha"] } : undefined,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          channel: true,
          releaseTag: true,
          gitSha: true,
          failureReason: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      for (const row of rows) console.log(`ROW ${JSON.stringify(row)}`);
      emit({ outcome: "status_listed", count: rows.length });
      break;
    }

    case "verify-running": {
      if (!flags["git-sha"]) throw new Error("verify-running: --git-sha is required");
      const row = await prisma.deviceUpdate.findFirst({
        where: { gitSha: flags["git-sha"] },
        orderBy: { createdAt: "desc" },
      });
      if (!row) throw new Error(`no DeviceUpdate row for gitSha ${flags["git-sha"]}`);
      const parsed = parseReleaseManifest(JSON.stringify(row.manifestJson));
      if (!parsed.ok) throw new Error(`manifest snapshot unparseable: ${parsed.detail}`);
      const runner = buildRunner();
      const refs = await runner.currentImageRefs(
        parsed.manifest.services.map((s) => s.name),
      );
      let mismatches = 0;
      for (const service of parsed.manifest.services) {
        const ref = refs[service.name];
        if (ref === null) {
          console.log(`SKIP ${service.name} (not deployed on this box)`);
          continue;
        }
        const ok = imageRefMatchesDigest(ref, service.digest);
        console.log(`${ok ? "MATCH" : "MISMATCH"} ${service.name} running=${ref} manifest=${service.digest}`);
        if (!ok) mismatches += 1;
      }
      // The orchestrator swaps LAST — call it out so a mid-swap read is
      // diagnosable from the workflow log.
      emit({
        outcome: mismatches === 0 ? "running_matches_manifest" : "running_mismatch",
        deviceUpdateId: row.id,
        status: row.status,
        mismatches,
        self: SELF_SERVICE_NAME,
      });
      if (mismatches > 0) process.exitCode = 1;
      break;
    }

    default:
      console.error(
        "usage: ota-e2e-drive.mjs settings|check|apply-window|status|verify-running [flags]",
      );
      process.exitCode = 64;
  }
} finally {
  await prisma.$disconnect();
}
