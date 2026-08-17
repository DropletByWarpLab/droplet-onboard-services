import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * WARP-1767 — the overlay connect agent must be reachable from a shipping box.
 *
 * The defect this guards was not a wrong value; it was an ABSENT one.
 * `OVERLAY_CONNECT_ENABLED` existed in exactly two places — the zod schema that
 * defaulted it false, and the index.ts gate that read it — and in no `.env`
 * template, no compose file, and no setup script. So the connect tick and the
 * idle-expiry sweep never registered on any box that shipped, and remote access
 * (ADR-031's whole customer promise) could not be turned on short of hand-
 * editing env over SSH.
 *
 * Two halves, and BOTH have to hold or the feature is dead again:
 *   1. the parsed default is ON, so a box whose .env predates the key still runs
 *      the agent (this is what every already-deployed box looks like); and
 *   2. the key is written into the artifacts that actually reach a box, so the
 *      value is visible and overridable by an operator rather than implicit.
 *
 * A test that only asserted (1) would pass against the original defect, because
 * the original defect was never about the schema.
 */

function findRepoRoot(): string {
  // Vitest may run from the repo root or from apps/orchestrator.
  const candidates = [
    process.cwd(),
    join(process.cwd(), "..", ".."),
    join(process.cwd(), "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, ".env.example"))) return resolve(candidate);
  }
  throw new Error(
    `Could not locate .env.example from ${process.cwd()} — tried ${candidates.join(", ")}`,
  );
}

const REPO_ROOT = findRepoRoot();
const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
const SECRETS_SH = readFileSync(
  join(REPO_ROOT, "scripts", "lib", "secrets.sh"),
  "utf8",
);

describe("WARP-1767 — OVERLAY_CONNECT_ENABLED reaches a shipping box", () => {
  const ORIGINAL = process.env.OVERLAY_CONNECT_ENABLED;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OVERLAY_CONNECT_ENABLED;
    else process.env.OVERLAY_CONNECT_ENABLED = ORIGINAL;
    vi.resetModules();
  });

  it("defaults ON when the key is absent, so boxes predating it still connect", async () => {
    delete process.env.OVERLAY_CONNECT_ENABLED;
    const { config } = await import("../config.js");
    expect(config.OVERLAY_CONNECT_ENABLED).toBe(true);
  });

  it("still honours an explicit opt-out", async () => {
    process.env.OVERLAY_CONNECT_ENABLED = "false";
    const { config } = await import("../config.js");
    expect(config.OVERLAY_CONNECT_ENABLED).toBe(false);
  });

  it("is written into .env.example with an explicit value", () => {
    // Not just mentioned in a comment — assigned. `^` + multiline so a commented
    // `# OVERLAY_CONNECT_ENABLED=...` line cannot satisfy this.
    expect(ENV_EXAMPLE).toMatch(/^OVERLAY_CONNECT_ENABLED=true$/m);
  });

  it("is seeded AND backfilled by secrets.sh", () => {
    // Seed block: fresh installs. The `${VAR:-default}` form keeps a
    // provisioning-environment override working.
    expect(SECRETS_SH).toMatch(
      /^OVERLAY_CONNECT_ENABLED=\$\{OVERLAY_CONNECT_ENABLED:-true\}$/m,
    );
    // Migrate block: the boxes ALREADY in the field, which is where the defect
    // actually bit. Without this they keep no key at all and stay unreachable
    // through every future setup.sh re-run.
    expect(SECRETS_SH).toMatch(
      /_migrate_ensure_key\s+OVERLAY_CONNECT_ENABLED\s/,
    );
  });

  it("is not re-declared in a compose environment: block", () => {
    // The orchestrator gets this via `env_file: ../.env`. Adding it to a compose
    // `environment:` entry as ${OVERLAY_CONNECT_ENABLED:-true} would substitute
    // to an explicit EMPTY STRING when unset on the host — and an explicit empty
    // string is not `undefined`, so it defeats the zod .default() and silently
    // parses back to false. That is the exact trap WARP-1767 warned about.
    for (const rel of ["docker/docker-compose.yml", "docker-compose.yml"]) {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, "utf8")).not.toMatch(
        /OVERLAY_CONNECT_ENABLED/,
      );
    }
  });
});
