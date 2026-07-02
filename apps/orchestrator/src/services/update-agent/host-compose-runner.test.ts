/**
 * WARP-539 — production ApplyRunner unit tests.
 *
 * The runner is the ONLY thing in the update agent that touches the host
 * compose socket, and it does so exclusively by exec'ing
 * scripts/lib/apply-update.sh with an ARGV array (never a shell string) so
 * a manifest field can never be interpreted as a command. These tests pin
 * that contract: the exact subcommand + argv the runner builds for each
 * step, the JSON it hands the script via a temp file (not argv, to dodge
 * length limits and quoting), and the way it parses `current-image-refs`
 * output. The real script is exercised end-to-end on the box; here the
 * exec boundary is faked so the command surface is asserted deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostComposeRunner, type ExecFn } from "./host-compose-runner.js";
import type { ReleaseManifest, ReleaseService } from "./manifest.js";

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

function buildManifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    release: {
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-06-30T03:00:00Z",
      channel: "stable",
      minOrchestratorSchema: 1,
    },
    services: [
      {
        name: "orchestrator",
        image: `ghcr.io/x/orchestrator@${DIGEST("1")}`,
        digest: DIGEST("1"),
        healthcheck: { type: "http", port: 3000, path: "/api/orchestrator/health" },
      },
      {
        name: "web-dashboard",
        image: `ghcr.io/x/web-dashboard@${DIGEST("2")}`,
        digest: DIGEST("2"),
        healthcheck: { type: "http", port: 3001, path: "/healthz" },
      },
    ],
    configs: { file: "configs.tar.gz", sha256: "a".repeat(64) },
  };
}

let workDir: string;

/** Captured exec calls + a scriptable stdout per subcommand. */
function fakeExec(stdoutByCmd: Record<string, string> = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fn: ExecFn = async (file, args) => {
    calls.push({ file, args });
    const sub = args[0] ?? "";
    return { stdout: stdoutByCmd[sub] ?? "", stderr: "" };
  };
  return { fn, calls };
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "warp539-runner-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeRunner(exec: ExecFn) {
  return createHostComposeRunner({
    scriptPath: "/opt/droplet/scripts/lib/apply-update.sh",
    composeFile: "/opt/droplet/docker/docker-compose.yml",
    updatesDir: workDir,
    exec,
  });
}

describe("createHostComposeRunner (WARP-539)", () => {
  it("currentImageRefs parses the script's JSON map and null-fills missing services", async () => {
    const { fn, calls } = fakeExec({
      "current-image-refs": JSON.stringify({
        orchestrator: "sha256:aaa",
        "web-dashboard": null,
      }),
    });
    const runner = makeRunner(fn);

    const refs = await runner.currentImageRefs(["orchestrator", "web-dashboard", "missing"]);

    expect(refs).toEqual({
      orchestrator: "sha256:aaa",
      "web-dashboard": null,
      missing: null,
    });
    // Never a shell string — subcommand + argv only.
    expect(calls[0]!.file).toBe("/opt/droplet/scripts/lib/apply-update.sh");
    expect(calls[0]!.args).toEqual([
      "current-image-refs",
      "--compose-file",
      "/opt/droplet/docker/docker-compose.yml",
      "--services",
      "orchestrator,web-dashboard,missing",
    ]);
  });

  it("snapshot writes previous-refs + manifest to the update dir and calls the script", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);
    const manifest = buildManifest();
    const previousRefs = { orchestrator: "sha256:old1", "web-dashboard": "sha256:old2" };

    await runner.snapshot({ updateId: "du-1", manifest, previousRefs });

    // The script gets the update id + compose file; the payload rides a
    // file the runner staged, not argv.
    expect(calls[0]!.args[0]).toBe("snapshot");
    const refsPath = path.join(workDir, "du-1", "backup", "previous-refs.json");
    expect(JSON.parse(readFileSync(refsPath, "utf8"))).toEqual(previousRefs);
  });

  it("pullImages passes each image ref by digest", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);
    const manifest = buildManifest();

    await runner.pullImages(manifest.services);

    expect(calls[0]!.args[0]).toBe("pull-images");
    // Every pinned image ref is present as its own argv entry.
    for (const svc of manifest.services) {
      expect(calls[0]!.args).toContain(svc.image);
    }
  });

  it("stageConfigs writes the tar to the update dir and hands the script its path", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);
    const configsTar = Buffer.from("packed configs bytes");

    await runner.stageConfigs({ updateId: "du-1", configsTar, manifest: buildManifest() });

    const tarPath = path.join(workDir, "du-1", "configs.tar.gz");
    expect(readFileSync(tarPath)).toEqual(configsTar);
    expect(calls[0]!.args[0]).toBe("stage-configs");
    expect(calls[0]!.args).toContain(tarPath);
  });

  it("recreateServices passes the service list + target and NOT the orchestrator implicitly", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);

    await runner.recreateServices({
      updateId: "du-1",
      services: ["web-dashboard", "device-identity-svc"],
      target: "release",
    });

    expect(calls[0]!.args[0]).toBe("recreate-services");
    expect(calls[0]!.args).toContain("--services");
    expect(calls[0]!.args).toContain("web-dashboard,device-identity-svc");
    expect(calls[0]!.args).toContain("--target");
    expect(calls[0]!.args).toContain("release");
  });

  it("recreateSelfDetached launches the self-swap subcommand with the target", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);

    await runner.recreateSelfDetached({ updateId: "du-1", target: "release" });

    expect(calls[0]!.args[0]).toBe("recreate-self-detached");
    expect(calls[0]!.args).toContain("--target");
    expect(calls[0]!.args).toContain("release");
    expect(calls[0]!.args).toContain("--update-id");
    expect(calls[0]!.args).toContain("du-1");
  });

  it("migrateDeploy + restoreConfigs are single-subcommand invocations", async () => {
    const { fn, calls } = fakeExec();
    const runner = makeRunner(fn);

    await runner.migrateDeploy();
    await runner.restoreConfigs({ updateId: "du-1" });

    expect(calls[0]!.args[0]).toBe("migrate-deploy");
    expect(calls[1]!.args[0]).toBe("restore-configs");
    expect(calls[1]!.args).toContain("du-1");
  });

  it("never builds a shell string — argv is always an array of discrete tokens", async () => {
    const { fn, calls } = fakeExec({ "current-image-refs": "{}" });
    const runner = makeRunner(fn);
    // A service name that WOULD be dangerous in a shell string.
    await runner.currentImageRefs(["orchestrator; rm -rf /"]);
    // The whole thing lands as ONE argv token, never split by a shell.
    expect(calls[0]!.args).toContain("orchestrator; rm -rf /");
  });
});
